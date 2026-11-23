/**
 * The owner's MCP server end to end, through the official MCP client over the router, with
 * access tokens signed by a local stand-in for the IdP.
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { createRouter } from "@remix-run/fetch-router";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";

import { routes } from "../../client/routes.ts";
import { openLocalDatabase } from "../db/local.ts";
import { createOpinion } from "../lib/opinions.ts";
import { ensureUser } from "../middleware/auth.ts";
import { createMcpController } from "./mod.ts";

const ISSUER = "https://idp.test";
const RESOURCE = "https://app.test/mcp";

async function setup() {
  await openLocalDatabase(":memory:");
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "ES256" };
  const router = createRouter();
  router.map(
    routes.mcp,
    createMcpController({
      jwks: createLocalJWKSet({ keys: [jwk] }),
      issuer: ISSUER,
    }) as never,
  );
  const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    router.fetch(new Request(input, init));

  /** An access token as the IdP issues them for this server. */
  const accessToken = (
    sub: string,
    { aud = RESOURCE, typ = "at+jwt" } = {},
  ) =>
    new SignJWT({ scope: "mcp", client_id: "https://client.test/cimd" })
      .setProtectedHeader({ alg: "ES256", kid: "k1", typ })
      .setIssuer(ISSUER)
      .setSubject(sub)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  /** An MCP client signed in as `sub`. */
  const clientFor = async (sub: string) => {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch,
        requestInit: {
          headers: { authorization: `Bearer ${await accessToken(sub)}` },
        },
      }),
    );
    return client;
  };

  return { fetch, accessToken, clientFor };
}

/** A tool's JSON answer, or its error text. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0].text;
  return result.isError
    ? { error: text }
    : JSON.parse(text) as Record<string, unknown>;
}

Deno.test("without a token: 401 pointing at the metadata, which names the IdP", async () => {
  const { fetch } = await setup();
  const res = await fetch(RESOURCE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assertEquals(res.status, 401);
  assertMatch(
    res.headers.get("www-authenticate") ?? "",
    /resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
  await res.body?.cancel();

  const meta = await fetch(
    "https://app.test/.well-known/oauth-protected-resource/mcp",
  );
  assertEquals(await meta.json(), {
    resource: RESOURCE,
    authorization_servers: [ISSUER],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
    resource_name: "idobata-bot（文書オーナー向け）",
  });
});

Deno.test("a token for another server, or the web's session token, is refused", async () => {
  const { fetch, accessToken } = await setup();
  for (
    const token of [
      await accessToken("u1", { aud: "https://other.test/mcp" }),
      await accessToken("u1", { typ: "JWT" }),
    ]
  ) {
    const res = await fetch(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  }
});

Deno.test("the owner registers, drafts, releases and moderates", async () => {
  const { clientFor } = await setup();
  const owner = await clientFor("owner-1");

  const { tools } = await owner.listTools();
  assertEquals(tools.map((t) => t.name).sort(), [
    "create_document",
    "discard_draft",
    "get_document",
    "get_draft",
    "get_filter_stats",
    "list_my_documents",
    "list_opinions_for_owner",
    "moderate_opinion",
    "release_draft",
    "save_draft",
    "update_document",
  ]);

  const created = await call(owner, "create_document", {
    title: "計画案",
    markdown: "# 計画\n\n予算は100万円。\n",
  });
  const id = created.id as string;
  assertEquals(
    ((await call(owner, "list_my_documents")).documents as { id: string }[])
      .map((d) => d.id),
    [id],
  );

  const updated = await call(owner, "update_document", {
    document_id: id,
    title: "計画案（改）",
  });
  assertEquals((updated.document as { title: string }).title, "計画案（改）");

  // The draft starts from the release, with the paragraph IDs in view.
  const start = (await call(owner, "get_draft", { document_id: id }))
    .draft as { markdown: string; saved: boolean };
  assertEquals(start.saved, false);
  const budgetKey = /<!-- #(\S+) -->\n予算/.exec(start.markdown)![1];

  const saved = (await call(owner, "save_draft", {
    document_id: id,
    markdown: start.markdown.replace("100万円", "120万円") + "\n新しい段落。\n",
  })).draft as { number: number; markdown: string };
  assertEquals(saved.number, 2);
  assertMatch(saved.markdown, /<!-- #\S+ -->\n新しい段落。/);

  const released = await call(owner, "release_draft", {
    document_id: id,
    release_note: "予算を直した",
  });
  assertEquals(released.released, 2);
  const segments = (released.document as {
    segments: { key: string; text: string }[];
  }).segments;
  assertEquals(
    segments.find((s) => s.text === "予算は120万円。")?.key,
    budgetKey,
  );

  // Someone posts an opinion; the owner hides it, with a reason.
  await ensureUser("reader-1", "読者");
  const opinion = await createOpinion(id, "reader-1", {
    title: "高すぎる",
    body: "",
    targets: [{ kind: "segment", segmentKey: budgetKey, stance: "concern" }],
  });
  const hidden = await call(owner, "moderate_opinion", {
    opinion_id: opinion.id,
    action: "hide",
    reason: "重複のため",
  });
  assertEquals((hidden.opinion as { status: string }).status, "hidden");
  const view = await call(owner, "list_opinions_for_owner", {
    document_id: id,
  });
  assertEquals(
    (view.moderation as { reason: string }[]).map((m) => m.reason),
    ["重複のため"],
  );
  assertEquals(
    (await call(owner, "get_filter_stats", { document_id: id })).filterStats,
    [],
  );

  // Without a reason it is refused, as on the web.
  const noReason = await call(owner, "moderate_opinion", {
    opinion_id: opinion.id,
    action: "unhide",
    reason: " ",
  });
  assert("error" in noReason);
});

Deno.test("another user cannot touch the owner's document", async () => {
  const { clientFor } = await setup();
  const owner = await clientFor("owner-1");
  const id = (await call(owner, "create_document", {
    title: "t",
    markdown: "本文",
  })).id as string;

  const other = await clientFor("someone-else");
  for (
    const [tool, args] of [
      ["get_draft", { document_id: id }],
      ["save_draft", { document_id: id, markdown: "乗っ取り" }],
      ["release_draft", { document_id: id }],
      ["update_document", { document_id: id, title: "x" }],
      ["list_opinions_for_owner", { document_id: id }],
    ] as const
  ) {
    const result = await call(other, tool, args);
    assertEquals(result, {
      error: "only the document's owner may do this",
    }, tool);
  }
  assertEquals(
    (await call(other, "list_my_documents")).documents,
    [],
  );
});
