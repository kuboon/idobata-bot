/**
 * The chat model behind one interface, so the chat's logic is tested against a scripted stand-in
 * and only this file talks to the Claude API.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaToolUnion,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

/** One request: the system prompt, the conversation, and the tools. */
export interface ModelRequest {
  system: BetaTextBlockParam[];
  messages: BetaMessageParam[];
  tools: BetaToolUnion[];
}

export interface ChatModel {
  /**
   * Runs one model turn, calling `onText` with each piece of text as it streams.
   *
   * @param signal Aborts the call — the reader closed the chat
   * @returns The complete message — thinking blocks and all, to be appended to the history as is
   */
  run(
    request: ModelRequest,
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<BetaMessage>;
}

/** Sonnet 5.5 at low effort: a chat, not a reasoning task (docs/architecture.md §5). */
export const CHAT_MODEL = "claude-sonnet-5-5";

/** The Claude API, streamed. */
export function anthropicModel(apiKey: string): ChatModel {
  const client = new Anthropic({ apiKey });
  return {
    async run(request, onText, signal) {
      const stream = client.beta.messages.stream({
        model: CHAT_MODEL,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        // A refusal is retried on a fallback model chosen by refusal category, inside the call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: request.system,
        messages: request.messages,
        tools: request.tools,
        tool_choice: { type: "auto" },
        // The conversation after the document is cached too, turn by turn.
        cache_control: { type: "ephemeral" },
      }, { signal });
      stream.on("text", onText);
      return await stream.finalMessage();
    },
  };
}
