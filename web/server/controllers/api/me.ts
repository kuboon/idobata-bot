/**
 * `/api/me` — the signed-in user's own record: who they are here, the nickname they go by, and
 * the documents they registered.
 *
 * The nickname is this app's, seeded from the IdP's on first sign-in (docs/design.md §5).
 */

import { createController } from "@remix-run/fetch-router";

import { routes } from "../../../client/routes.ts";
import { getDb } from "../../db/mod.ts";
import { now, users } from "../../db/schema.ts";
import { listDocuments } from "../../lib/documents.ts";
import {
  dpopClient,
  NICKNAME_MAX_LENGTH,
  requireUser,
  type RequireUserOptions,
  User,
} from "../../middleware/auth.ts";

/**
 * The controller, with the IdP's keys injectable for tests.
 *
 * @param auth Passed to {@link requireUser}
 */
export function createMeController(auth: RequireUserOptions = {}) {
  return createController(routes.api.me, {
    middleware: [dpopClient(), requireUser(auth)],
    actions: {
      show(context) {
        const user = context.get(User);
        return Response.json(user, {
          headers: { "cache-control": "no-store" },
        });
      },

      async documents(context) {
        const user = context.get(User);
        return Response.json({ documents: await listDocuments(user.id) }, {
          headers: { "cache-control": "no-store" },
        });
      },

      async update(context) {
        const user = context.get(User);
        let body: unknown;
        try {
          body = await context.request.json();
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const raw = (body as { nickname?: unknown } | null)?.nickname;
        const nickname = typeof raw === "string" ? raw.trim() : "";
        if (!nickname || nickname.length > NICKNAME_MAX_LENGTH) {
          return Response.json({
            error: `nickname must be 1–${NICKNAME_MAX_LENGTH} characters`,
          }, { status: 400 });
        }

        await getDb().update(users, user.id, { nickname, updated_at: now() });
        return Response.json({ id: user.id, nickname }, {
          headers: { "cache-control": "no-store" },
        });
      },
    },
  });
}
