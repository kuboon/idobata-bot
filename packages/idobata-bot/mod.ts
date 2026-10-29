/**
 * `@kuboon/idobata-bot` — the opinion module: what a page needs to let its readers post opinions
 * and supports about a document, against the idobata-bot opinion service.
 *
 * For now this is the service's API types, a client for it, and where the chat posts. The UI (segment selection, the AI
 * chat, the opinion form) lives in the idobata-bot site and moves here once it works there
 * (docs/design.md §2).
 *
 * @module
 */

export * from "./types.ts";
export * from "./client.ts";
export * from "./chat.ts";
