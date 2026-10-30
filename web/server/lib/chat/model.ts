/**
 * The chat model behind one interface, so the chat's logic is tested against a scripted stand-in
 * and only this file talks to the model.
 *
 * The model is Workers AI's `@cf/qwen/qwen3.8-27b`, through the same `env.AI` binding as the
 * pre-filter — no API key. Messages and tools are in the OpenAI chat-completions shape, which
 * Workers AI takes for this model; the streamed answer is read in that shape too, and in Workers
 * AI's older `{ response, tool_calls }` one, so a model swap does not silently break it.
 */

import type { AiBinding } from "./ai.ts";

/** A call the model made to one of its tools. `arguments` is the JSON the model wrote. */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** One message of the conversation, in the chat-completions shape. */
export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
    role: "assistant";
    content: string;
    tool_calls?: {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }[];
  }
  | { role: "tool"; tool_call_id: string; content: string };

/** A tool as the model is offered it. */
export interface ModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** One request: the conversation (system message first) and the tools. */
export interface ModelRequest {
  messages: ModelMessage[];
  tools: ModelTool[];
}

/** Why the model stopped. */
export type FinishReason = "stop" | "tool_calls" | "length" | "other";

/** The model's turn, complete. */
export interface ModelReply {
  content: string;
  toolCalls: ModelToolCall[];
  finishReason: FinishReason;
}

export interface ChatModel {
  /**
   * Runs one model turn, calling `onText` with each piece of text as it streams.
   *
   * @param signal Aborts the call — the reader closed the chat
   */
  run(
    request: ModelRequest,
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<ModelReply>;
}

/** Qwen 3.8 27B on Workers AI (docs/architecture.md §5). */
export const CHAT_MODEL = "@cf/qwen/qwen3.8-27b";
/** Enough for a reply and a draft; a chat panel answer that needs more should be shorter. */
export const MAX_COMPLETION_TOKENS = 4096;

/** The model on Workers AI, streamed. */
export function workersAiModel(ai: AiBinding): ChatModel {
  return {
    async run(request, onText, signal) {
      const stream = await ai.run(CHAT_MODEL, {
        messages: request.messages,
        tools: request.tools,
        tool_choice: "auto",
        stream: true,
        // The model's default is xhigh; a chat turn is not a reasoning task.
        reasoning_effort: "low",
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      });
      if (!(stream instanceof ReadableStream)) {
        // A binding that answered in one piece.
        return readCompletion(stream, onText);
      }
      return await readCompletionStream(stream, onText, signal);
    },
  };
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Accumulates a reply from chunks of either shape. */
class ReplyBuilder {
  content = "";
  finishReason: FinishReason = "stop";
  #calls = new Map<number, ModelToolCall>();

  constructor(private readonly onText: (text: string) => void) {}

  #text(text: unknown) {
    if (typeof text === "string" && text !== "") {
      this.content += text;
      this.onText(text);
    }
  }

  #finish(reason: unknown) {
    if (reason === "tool_calls") this.finishReason = "tool_calls";
    else if (reason === "length") this.finishReason = "length";
    else if (typeof reason === "string" && reason !== "stop") {
      this.finishReason = "other";
    }
  }

  /** One chunk, or a whole non-streamed answer. */
  push(chunk: Json) {
    const choice = Array.isArray(chunk.choices) && isRecord(chunk.choices[0])
      ? chunk.choices[0]
      : null;
    if (choice) {
      // Chat-completions: `delta` when streamed, `message` when not.
      const part = isRecord(choice.delta)
        ? choice.delta
        : isRecord(choice.message)
        ? choice.message
        : {};
      this.#text(part.content);
      if (Array.isArray(part.tool_calls)) {
        part.tool_calls.forEach((raw, i) => this.#toolCall(raw, i));
      }
      this.#finish(choice.finish_reason);
      return;
    }
    // Workers AI's own shape: `response` text, and whole `tool_calls` at the end.
    this.#text(chunk.response);
    if (Array.isArray(chunk.tool_calls)) {
      chunk.tool_calls.forEach((raw, i) => this.#toolCall(raw, i));
    }
  }

  /** A tool call or a streamed piece of one, merged by its index. */
  #toolCall(raw: unknown, position: number) {
    if (!isRecord(raw)) return;
    const index = typeof raw.index === "number" ? raw.index : position;
    const fn = isRecord(raw.function) ? raw.function : raw;
    const call = this.#calls.get(index) ??
      { id: "", name: "", arguments: "" };
    if (typeof raw.id === "string" && raw.id) call.id = raw.id;
    if (typeof fn.name === "string" && fn.name) call.name = fn.name;
    const args = fn.arguments;
    if (typeof args === "string") call.arguments += args;
    else if (isRecord(args)) call.arguments = JSON.stringify(args);
    this.#calls.set(index, call);
  }

  reply(): ModelReply {
    const toolCalls = [...this.#calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        ...call,
        id: call.id || `call_${crypto.randomUUID()}`,
        arguments: call.arguments || "{}",
      }))
      .filter((call) => call.name);
    return {
      content: this.content,
      toolCalls,
      // Some models report `stop` even when they called tools.
      finishReason: toolCalls.length > 0 ? "tool_calls" : this.finishReason,
    };
  }
}

/** A non-streamed answer. */
export function readCompletion(
  answer: unknown,
  onText: (text: string) => void = () => {},
): ModelReply {
  const builder = new ReplyBuilder(onText);
  if (isRecord(answer)) builder.push(answer);
  return builder.reply();
}

/**
 * A streamed answer: server-sent events, each `data:` line one JSON chunk, ending with
 * `data: [DONE]`.
 */
export async function readCompletionStream(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  signal?: AbortSignal,
): Promise<ModelReply> {
  const builder = new ReplyBuilder(onText);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  const line = (text: string) => {
    if (!text.startsWith("data:")) return;
    const data = text.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data);
      if (isRecord(chunk)) builder.push(chunk);
    } catch {
      // A malformed line is skipped rather than failing the turn.
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ""));
        buffer = buffer.slice(end + 1);
      }
    }
    line(buffer + decoder.decode());
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  return builder.reply();
}
