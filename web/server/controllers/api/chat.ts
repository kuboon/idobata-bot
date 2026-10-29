/**
 * `POST /api/docs/:docId/chat?v=<version>&s=<segment keys>` — one turn of the AI chat about a
 * document, in `@remix-kbn/helper-agent`'s wire format (docs/design.md §6). The query fixes what
 * the conversation is about: the version and the paragraphs selected when it started. Open to
 * anyone with a DPoP key: chatting needs no sign-in, posting what comes of it does.
 */

import { createController } from "@remix-run/fetch-router";
import { helperAgentController } from "@remix-kbn/helper-agent/controller";

import { routes } from "../../../client/routes.ts";
import { getConfig } from "../../config.ts";
import {
  chatAgent,
  chatDocument,
  ChatError,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_MESSAGES,
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

/** The version and the first selection, from the query. */
function subjectOf(url: URL): { versionNumber: number; segmentKeys: string[] } {
  const versionNumber = Number(url.searchParams.get("v"));
  const segmentKeys = (url.searchParams.get("s") ?? "").split(",").filter(
    Boolean,
  );
  if (!Number.isInteger(versionNumber) || versionNumber < 1) {
    throw new ChatError(400, "invalid v");
  }
  if (segmentKeys.length > 200) throw new ChatError(400, "invalid s");
  return { versionNumber, segmentKeys };
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
        let subject;
        try {
          const { versionNumber, segmentKeys } = subjectOf(
            new URL(context.request.url),
          );
          subject = {
            document: await chatDocument(context.params.docId, versionNumber),
            segmentKeys,
          };
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
        return await helperAgentController(chatAgent(subject, chatModel), {
          maxMessages: HISTORY_MAX_MESSAGES,
          maxBytes: HISTORY_MAX_BYTES,
        })(context);
      },
    },
  });
}
