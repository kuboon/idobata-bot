/**
 * `/api/docs` — the document list, one document with its segments, registering a new one, and
 * the owner changing its title, description or deadline, and writing and releasing its next
 * version.
 *
 * Reading is open to anyone with a DPoP key; registering needs a signed-in user, and for now any
 * signed-in user may (docs/design.md §11 — a sysad role can restrict it later).
 */

import { createController } from "@remix-run/fetch-router";

import { routes } from "../../../client/routes.ts";
import {
  createDocument,
  discardDraft,
  documentOwner,
  getDocument,
  getDraft,
  listDocuments,
  parseDocumentPatch,
  parseMarkdown,
  parseNewDocument,
  RELEASE_NOTE_MAX_LENGTH,
  releaseDraft,
  saveDraft,
  updateDocument,
} from "../../lib/documents.ts";
import {
  dpopClient,
  requireUser,
  type RequireUserOptions,
  User,
} from "../../middleware/auth.ts";

const noStore = { "cache-control": "no-store" };

/** A `Response` when the user is not the document's owner (or there is no document), else `null`. */
async function notOwner(docId: string, user: User): Promise<Response | null> {
  const owner = await documentOwner(docId);
  if (owner === null) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (owner !== user.id) {
    return Response.json({
      error: "only the document's owner may do this",
    }, { status: 403 });
  }
  return null;
}

/** The request's JSON body, or `undefined` when it is not JSON. */
async function jsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const invalidJson = () =>
  Response.json({ error: "invalid JSON" }, { status: 400 });

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

      update: {
        middleware: [requireUser(auth)],
        async handler(context) {
          const { docId } = context.params;
          const refused = await notOwner(docId, context.get(User) as User);
          if (refused) return refused;
          const body = await jsonBody(context.request);
          if (body === undefined) return invalidJson();
          const parsed = parseDocumentPatch(body);
          if (!parsed.ok) {
            return Response.json({ error: parsed.error }, { status: 400 });
          }
          await updateDocument(docId, parsed.value);
          return Response.json(
            { document: await getDocument(docId) },
            { headers: noStore },
          );
        },
      },

      draft: {
        middleware: [requireUser(auth)],
        async handler(context) {
          const { docId } = context.params;
          const refused = await notOwner(docId, context.get(User) as User);
          if (refused) return refused;
          return Response.json({ draft: await getDraft(docId) }, {
            headers: noStore,
          });
        },
      },

      saveDraft: {
        middleware: [requireUser(auth)],
        async handler(context) {
          const { docId } = context.params;
          const refused = await notOwner(docId, context.get(User) as User);
          if (refused) return refused;
          const body = await jsonBody(context.request);
          if (body === undefined) return invalidJson();
          const markdown = parseMarkdown(
            (body as { markdown?: unknown } | null)?.markdown,
          );
          if (!markdown.ok) {
            return Response.json({ error: markdown.error }, { status: 400 });
          }
          return Response.json(
            { draft: await saveDraft(docId, markdown.value) },
            { headers: noStore },
          );
        },
      },

      discardDraft: {
        middleware: [requireUser(auth)],
        async handler(context) {
          const { docId } = context.params;
          const refused = await notOwner(docId, context.get(User) as User);
          if (refused) return refused;
          if (!await discardDraft(docId)) {
            return Response.json({ error: "no draft" }, { status: 404 });
          }
          return new Response(null, { status: 204 });
        },
      },

      release: {
        middleware: [requireUser(auth)],
        async handler(context) {
          const { docId } = context.params;
          const refused = await notOwner(docId, context.get(User) as User);
          if (refused) return refused;
          const body = await jsonBody(context.request);
          if (body === undefined) return invalidJson();
          const raw = (body as { releaseNote?: unknown } | null)?.releaseNote;
          const releaseNote = typeof raw === "string" ? raw.trim() : "";
          if (releaseNote.length > RELEASE_NOTE_MAX_LENGTH) {
            return Response.json({
              error:
                `releaseNote must be at most ${RELEASE_NOTE_MAX_LENGTH} characters`,
            }, { status: 400 });
          }
          const number = await releaseDraft(docId, releaseNote);
          if (number === null) {
            return Response.json({ error: "no draft" }, { status: 409 });
          }
          return Response.json(
            { document: await getDocument(docId) },
            { headers: noStore },
          );
        },
      },
    },
  });
}
