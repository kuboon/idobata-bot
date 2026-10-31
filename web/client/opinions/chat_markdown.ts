/**
 * The AI's replies in the chat panel, rendered as Markdown — the model writes lists, emphasis and
 * code. Handed to the panel as its `renderReply` (`@kuboon/chat-element` 0.1.1), which calls it
 * for each reply as it changes, the greeting included.
 *
 * `@kuboon/md` drops raw HTML and sanitises what it renders, as it does for the document.
 */

import { hastToDom, markdownToHast } from "@kuboon/md";

/** A reply's Markdown as DOM, its outside links opening in a new tab. */
export async function renderMarkdownReply(text: string): Promise<Node> {
  const dom = hastToDom(await markdownToHast(text));
  for (const link of (dom as ParentNode).querySelectorAll("a[href]")) {
    if (link.getAttribute("href")?.startsWith("#")) continue;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  return dom;
}

const BUBBLE = ".chat-panel__bubble--assistant";

/** What the rendered Markdown needs inside a bubble. */
export const CHAT_MARKDOWN_CSS = `
${BUBBLE} :is(p, ul, ol, pre, blockquote, table) { margin-block: 0.5em; }
${BUBBLE} :is(ul, ol) { padding-inline-start: 1.25em; }
${BUBBLE} :is(h1, h2, h3, h4, h5, h6) { font-size: 1em; margin-block: 0.75em 0.25em; }
${BUBBLE} :is(h1, h2, h3, h4, h5, h6) a { color: inherit; text-decoration: none; }
${BUBBLE} pre { overflow-x: auto; white-space: pre; }
${BUBBLE} code { font-size: 0.9em; }
${BUBBLE} table { border-collapse: collapse; display: block; overflow-x: auto; }
${BUBBLE} :is(th, td) { border: 1px solid currentColor; padding: 0.15em 0.4em; }
`;
