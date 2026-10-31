/**
 * `<share-buttons>` (`@kuboon/share-element`): importing this registers the element, and tells
 * JSX about its one attribute.
 */

import "@kuboon/share-element";

declare global {
  namespace JSX {
    interface IntrinsicElements {
      /** X, LINE, Threads, the share sheet or copy, and a QR code; `url` defaults to the page. */
      "share-buttons": { url?: string; key?: string };
    }
  }
}
