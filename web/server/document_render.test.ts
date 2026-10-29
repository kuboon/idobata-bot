/**
 * The viewer's rendering (`client/lib/document.ts`) against the server's segmentation: every
 * segment comes back attached to the element it rendered to. Lives here rather than beside the
 * client code because `client/` is type-checked without Deno's globals.
 */

import { assertEquals } from "@std/assert";

import { renderDocument } from "../client/lib/document.ts";
import { parseSegments } from "./lib/segments.ts";

Deno.test("every segment is paired with its rendered element", async () => {
  const markdown = `# 題

本文[^1] と [参照][ref]。

- a
- b

| x |
| - |
| 1 |

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

\`\`\`ts
const a = 1;
\`\`\`

> 引用

[ref]: https://example.com

[^1]: 脚注
`;
  const segments = parseSegments(markdown).map((s, i) => ({
    key: `k${i}`,
    kind: s.kind,
    text: s.text,
    headingPath: s.headingPath,
  }));
  const blocks = await renderDocument(markdown, segments);

  const paired = blocks.map(({ segment, node }) => [
    segment?.key ?? null,
    node.type === "element" ? node.tagName : node.type,
  ]);
  // Every segment, once, in order; the footnotes section is the one element that is not one.
  assertEquals(
    paired.filter(([key]) => key !== null).map(([key]) => key),
    segments.map((s) => s.key),
  );
  assertEquals(paired.filter(([key]) => key === null).length, 1);
});
