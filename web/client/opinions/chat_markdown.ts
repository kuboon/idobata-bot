/**
 * The AI's replies in the chat panel, rendered as Markdown. The model writes lists, emphasis and
 * code; `@kuboon/chat-element` 0.1.0 shows a reply as plain text (with its URLs linked) and has no
 * hook for a renderer, so its bubbles are rendered here once they are drawn.
 *
 * The element redraws only the bubble whose text changed (it keys each by its text), so a bubble
 * this has rendered stays rendered, and a streaming one is a new element on every piece and is
 * rendered again. The text is read back from the drawn bubble, whose `textContent` is the reply:
 * a linked URL's text is the URL.
 *
 * `@kuboon/md` drops raw HTML and sanitises what it renders, as it does for the document.
 */

import { hastToDom, markdownToHast } from "@kuboon/md";

const BUBBLE = ".chat-panel__bubble--assistant";
/** Set on a bubble once it is taken, before the rendering finishes, so it is taken once. */
const RENDERED = "data-markdown";

async function render(bubble: HTMLElement): Promise<void> {
  bubble.setAttribute(RENDERED, "");
  const source = bubble.textContent ?? "";
  const dom = hastToDom(await markdownToHast(source));
  // Redrawn while this was rendering: the newer bubble is rendered on its own.
  if (!bubble.isConnected || bubble.textContent !== source) return;
  for (const link of (dom as ParentNode).querySelectorAll("a[href]")) {
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  }
  bubble.replaceChildren(dom);
}

/**
 * Renders the assistant's bubbles in this panel as Markdown, now and as they are drawn.
 *
 * @param root The panel's element
 * @param signal Stops watching it
 */
export function renderRepliesAsMarkdown(
  root: HTMLElement,
  signal?: AbortSignal,
): void {
  const pass = () => {
    for (const bubble of root.querySelectorAll<HTMLElement>(BUBBLE)) {
      if (!bubble.hasAttribute(RENDERED)) void render(bubble);
    }
  };
  const observer = new MutationObserver(pass);
  observer.observe(root, { childList: true, subtree: true });
  signal?.addEventListener("abort", () => observer.disconnect(), {
    once: true,
  });
  pass();
}

/** What the rendered Markdown needs inside a bubble, which is styled for plain text. */
export const CHAT_MARKDOWN_CSS = `
${BUBBLE}[${RENDERED}] { white-space: normal; }
${BUBBLE}[${RENDERED}] > :first-child { margin-top: 0; }
${BUBBLE}[${RENDERED}] > :last-child { margin-bottom: 0; }
${BUBBLE}[${RENDERED}] :is(p, ul, ol, pre, blockquote, table) { margin-block: 0.5em; }
${BUBBLE}[${RENDERED}] :is(ul, ol) { padding-inline-start: 1.25em; }
${BUBBLE}[${RENDERED}] :is(h1, h2, h3, h4, h5, h6) { font-size: 1em; margin-block: 0.75em 0.25em; }
${BUBBLE}[${RENDERED}] :is(h1, h2, h3, h4, h5, h6) a { color: inherit; text-decoration: none; }
${BUBBLE}[${RENDERED}] pre { overflow-x: auto; white-space: pre; }
${BUBBLE}[${RENDERED}] code { font-size: 0.9em; }
${BUBBLE}[${RENDERED}] table { border-collapse: collapse; display: block; overflow-x: auto; }
${BUBBLE}[${RENDERED}] :is(th, td) { border: 1px solid currentColor; padding: 0.15em 0.4em; }
`;
