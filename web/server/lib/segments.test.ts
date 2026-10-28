import { assertEquals } from "@std/assert";

import { parseSegments } from "./segments.ts";

const kinds = (md: string) =>
  parseSegments(md).map(({ kind, text }) => [kind, text]);

Deno.test("each top-level block is a segment, in order", () => {
  assertEquals(
    kinds(`# 題名

最初の段落。
二行目も同じ段落。

- 項目 1
- 項目 2

  項目 2 の続き
- 項目 3

| a | b |
| - | - |
| 1 | 2 |

> 引用
> 続き

\`\`\`ts
const x = 1;

const y = 2;
\`\`\`

---

最後の段落。`),
    [
      ["heading", "# 題名"],
      ["paragraph", "最初の段落。\n二行目も同じ段落。"],
      ["list", "- 項目 1\n- 項目 2\n\n  項目 2 の続き\n- 項目 3"],
      ["table", "| a | b |\n| - | - |\n| 1 | 2 |"],
      ["quote", "> 引用\n> 続き"],
      ["code", "```ts\nconst x = 1;\n\nconst y = 2;\n```"],
      ["paragraph", "最後の段落。"],
    ],
  );
});

Deno.test("a heading ends the paragraph above it", () => {
  assertEquals(kinds("段落\n## 見出し\n本文"), [
    ["paragraph", "段落"],
    ["heading", "## 見出し"],
    ["paragraph", "本文"],
  ]);
});

Deno.test("heading paths track the headings above each block", () => {
  const paths = parseSegments(`# 第1章
本文1
## 1.1 節
本文2
# 第2章 {#ch2}
本文3
### 深い見出し
本文4`).map(({ text, headingPath }) => [text, headingPath]);
  assertEquals(paths, [
    ["# 第1章", ""],
    ["本文1", "第1章"],
    ["## 1.1 節", "第1章"],
    ["本文2", "第1章 > 1.1 節"],
    ["# 第2章 {#ch2}", ""],
    ["本文3", "第2章"],
    ["### 深い見出し", "第2章"],
    ["本文4", "第2章 > 深い見出し"],
  ]);
});

Deno.test("an unclosed fence runs to the end", () => {
  assertEquals(kinds("```\ncode\n\nmore"), [["code", "```\ncode\n\nmore"]]);
});

Deno.test("CRLF and surrounding blank lines are normalised", () => {
  assertEquals(kinds("\r\n\r\n段落\r\n続き\r\n\r\n"), [[
    "paragraph",
    "段落\n続き",
  ]]);
});

Deno.test("an empty document has no segments", () => {
  assertEquals(parseSegments("  \n\n---\n"), []);
});
