/**
 * `/api/docs` — the document list, one document with its segments, and registering a new one.
 *
 * Reading is open to anyone with a DPoP key; registering needs a signed-in user, and for now any
 * signed-in user may (docs/design.md §12 — a sysad role can restrict it later).
 */

import { createController } from "@remix-run/fetch-router";

import { routes } from "../../../client/routes.ts";
import {
  createDocument,
  getDocument,
  listDocuments,
  parseNewDocument,
} from "../../lib/documents.ts";
import {
  dpopClient,
  requireUser,
  type RequireUserOptions,
  User,
} from "../../middleware/auth.ts";

const noStore = { "cache-control": "no-store" };

/**
 * The controller, with the IdP's keys injectable for tests.
 *
 * @param auth Passed to {@link requireUser}
 */
export function createDocsController(auth: RequireUserOptions = {}) {
  return createController(routes.api.docs, {
    middleware: [dpopClient()],
    actions: {
      async index() {
        return Response.json({ documents: await listDocuments() }, {
          headers: noStore,
        });
      },

      async show(context) {
        const raw = new URL(context.request.url).searchParams.get("version");
        const version = raw === null ? undefined : Number(raw);
        if (version !== undefined && !Number.isInteger(version)) {
          return Response.json({ error: "invalid version" }, { status: 400 });
        }
        const document = await getDocument(context.params.docId, version);
        if (!document) {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        return Response.json({ document }, { headers: noStore });
      },

      create: {
        middleware: [requireUser(auth)],
        async handler(context) {
          let body: unknown;
          try {
            body = await context.request.json();
          } catch {
            return Response.json({ error: "invalid JSON" }, { status: 400 });
          }
          const parsed = parseNewDocument(body);
          if (!parsed.ok) {
            return Response.json({ error: parsed.error }, { status: 400 });
          }
          // Set by this action's own `requireUser`, which the controller's types do not see.
          const user = context.get(User) as User;
          const id = await createDocument(user.id, parsed.value);
          return Response.json({ id }, { status: 201, headers: noStore });
        },
      },
    },
  });
}
