/**
 * The opinion service's API (③ in docs/design.md §2) — `packages/idobata-bot`'s `createOpinionClient`
 * is its client, and the request and response shapes are that package's types.
 *
 * Reading is open to anyone with a DPoP key (signed in, it also says which opinions are yours and
 * which you support); writing needs a signed-in user.
 */

import { createController } from "@remix-run/fetch-router";

import { routes } from "../../../client/routes.ts";
import {
  createOpinion,
  deleteOpinion,
  getOpinionDetail,
  listMyOpinions,
  listOpinions,
  OpinionError,
  parseOpinionInput,
  setSupport,
  updateOpinion,
} from "../../lib/opinions.ts";
import {
  dpopClient,
  optionalUser,
  requireUser,
  type RequireUserOptions,
  User,
} from "../../middleware/auth.ts";

const noStore = { "cache-control": "no-store" };

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: noStore });

/** Runs an action, turning an {@link OpinionError} into its HTTP answer. */
async function answer(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OpinionError) {
      return json({ error: error.message }, error.status);
    }
    throw error;
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new OpinionError(400, "invalid JSON");
  }
}

// Set by each action's own user middleware, which the controller's types do not see.
type UserContext = { get(key: typeof User): unknown };
const userOf = (context: UserContext) => context.get(User) as User;
const viewerOf = (context: UserContext) =>
  (context.get(User) as User | undefined)?.id ?? null;

/**
 * The controller, with the IdP's keys injectable for tests.
 *
 * @param auth Passed to the user middlewares
 */
export function createOpinionsController(auth: RequireUserOptions = {}) {
  const signedIn = [requireUser(auth)] as const;
  const maybeSignedIn = [optionalUser(auth)] as const;

  return createController(routes.api.opinions, {
    middleware: [dpopClient()],
    actions: {
      list: {
        middleware: maybeSignedIn,
        handler: (context) =>
          answer(async () =>
            json(await listOpinions(context.params.docId, viewerOf(context)))
          ),
      },
      show: {
        middleware: maybeSignedIn,
        handler: (context) =>
          answer(async () => {
            const opinion = await getOpinionDetail(
              context.params.opinionId,
              viewerOf(context),
            );
            if (!opinion) throw new OpinionError(404, "opinion not found");
            return json({ opinion });
          }),
      },
      create: {
        middleware: signedIn,
        handler: (context) =>
          answer(async () => {
            const input = parseOpinionInput(await readJson(context.request));
            const opinion = await createOpinion(
              context.params.docId,
              userOf(context).id,
              input,
            );
            return json({ opinion }, 201);
          }),
      },
      update: {
        middleware: signedIn,
        handler: (context) =>
          answer(async () => {
            const input = parseOpinionInput(await readJson(context.request));
            const opinion = await updateOpinion(
              context.params.opinionId,
              userOf(context).id,
              input,
            );
            return json({ opinion });
          }),
      },
      remove: {
        middleware: signedIn,
        handler: (context) =>
          answer(async () => {
            await deleteOpinion(context.params.opinionId, userOf(context).id);
            return new Response(null, { status: 204, headers: noStore });
          }),
      },
      support: {
        middleware: signedIn,
        handler: (context) =>
          answer(async () =>
            json({
              opinion: await setSupport(
                context.params.opinionId,
                userOf(context).id,
                true,
              ),
            })
          ),
      },
      unsupport: {
        middleware: signedIn,
        handler: (context) =>
          answer(async () =>
            json({
              opinion: await setSupport(
                context.params.opinionId,
                userOf(context).id,
                false,
              ),
            })
          ),
      },
      mine: {
        middleware: signedIn,
        handler: (context) =>
          answer(async () =>
            json({ opinions: await listMyOpinions(userOf(context).id) })
          ),
      },
    },
  });
}
