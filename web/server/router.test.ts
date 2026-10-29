import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import router from "./router.tsx";

Deno.test("GET / returns the shell with nav links and the runtime script", async () => {
  const res = await router.fetch(new Request("http://x/"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
  const html = await res.text();
  assertStringIncludes(html, "<!DOCTYPE html>");
  assertStringIncludes(html, "idobata-bot");
  assertStringIncludes(html, "<main");
  assertStringIncludes(html, '<script type="module" src="/assets/hydration');
  // Soft navigation is the runtime's default now; no frame target attributes.
  assert(!html.includes("rmx-target"));
});

Deno.test("GET /my embeds idp-origin meta", async () => {
  const res = await router.fetch(new Request("http://x/my"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, '<meta name="idp-origin"');
  assertStringIncludes(html, "https://id.kbn.one");
});

Deno.test("GET /sw.js serves the worker with a root scope", async () => {
  const res = await router.fetch(new Request("http://x/sw.js"));
  assertEquals(res.status, 200);
  assertStringIncludes(res.headers.get("content-type") ?? "", "javascript");
  assertEquals(res.headers.get("service-worker-allowed"), "/");
  assertStringIncludes(await res.text(), "addEventListener");
});

Deno.test("GET /.well-known/jwks.json publishes the RP key", async () => {
  const res = await router.fetch(
    new Request("http://x/.well-known/jwks.json"),
  );
  assertEquals(res.status, 200);
  const body = await res.json() as { keys: { kty: string }[] };
  assertEquals(body.keys[0].kty, "EC");
});

Deno.test("GET /og/index.png draws the home page's card", async () => {
  const res = await router.fetch(new Request("http://x/og/index.png"));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "image/png");
  await res.body?.cancel();
});

Deno.test("GET /new renders the registration page", async () => {
  const res = await router.fetch(new Request("http://x/new"));
  assertEquals(res.status, 200);
  const html = await res.text();
  assertStringIncludes(html, "文書を登録");
  assertStringIncludes(html, "new_document_form");
});

Deno.test("GET /d/:docId renders the document page for any ID", async () => {
  for (const id of ["_shell", "abc"]) {
    const res = await router.fetch(new Request(`http://x/d/${id}`));
    assertEquals(res.status, 200);
    const html = await res.text();
    assertStringIncludes(html, "document_view");
    assertStringIncludes(html, "<title>文書 — idobata-bot</title>");
  }
});

Deno.test("GET /d/:docId/admin renders the owner page for any ID", async () => {
  for (const id of ["_shell", "abc"]) {
    const res = await router.fetch(new Request(`http://x/d/${id}/admin`));
    assertEquals(res.status, 200);
    const html = await res.text();
    assertStringIncludes(html, "document_admin");
    assertStringIncludes(html, "<title>文書の管理 — idobata-bot</title>");
  }
});
