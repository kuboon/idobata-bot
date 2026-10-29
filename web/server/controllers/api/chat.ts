/**
 * `POST /api/docs/:docId/chat` — one turn of the AI chat about a document, streamed as
 * server-sent events (docs/design.md §6). Open to anyone with a DPoP key: chatting needs no
 * sign-in, posting what comes of it does.
 */

import type { ChatEvent } from "@kuboon/idobata-bot";
import { createController } from "@remix-run/fetch-router";

import { routes } from "../../../client/routes.ts";
import { getConfig } from "../../config.ts";
import {
  chatDocument,
  ChatError,
  parseChatRequest,
  runChatTurn,
} from "../../lib/chat/mod.ts";
import { anthropicModel, type ChatModel } from "../../lib/chat/model.ts";
import { dpopClient } from "../../middleware/auth.ts";

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

/** The Claude API with the configured key, or `null` when there is none. */
function configuredModel(): ChatModel | null {
  const { anthropicApiKey } = getConfig();
  return anthropicApiKey ? anthropicModel(anthropicApiKey) : null;
}

/**
 * The controller, with the model injectable for tests.
 *
 * @param model Makes the model for a turn, or `null` when the chat is not configured
 */
export function createChatController(
  model: () => ChatModel | null = configuredModel,
) {
  return createController(routes.api.chat, {
    middleware: [dpopClient()],
    actions: {
      async send(context) {
        let parsed, document;
        try {
          let body: unknown;
          try {
            body = await context.request.json();
          } catch {
            throw new ChatError(400, "invalid JSON");
          }
          parsed = parseChatRequest(body);
          document = await chatDocument(
            context.params.docId,
            parsed.versionNumber,
          );
        } catch (error) {
          if (error instanceof ChatError) {
            return json({ error: error.message }, error.status);
          }
          throw error;
        }
        const chatModel = model();
        if (!chatModel) {
          return json({ error: "チャットは準備中です。" }, 503);
        }

        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const emit = (event: ChatEvent) =>
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            await runChatTurn(document, parsed, chatModel, emit);
            controller.close();
          },
        });
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      },
    },
  });
}
