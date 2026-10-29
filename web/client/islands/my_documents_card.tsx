/**
 * MyDocumentsCard — the `/my` page's list of the documents the signed-in user registered, from
 * `GET /api/me/documents`, with the way to register another.
 *
 * There is no public list of documents: a document is reached by its link, and its owner finds it
 * here.
 */

import {
  clientEntry,
  css,
  type Handle,
  type SerializableValue,
} from "@remix-run/component";

import { deadlineLabel } from "../lib/format.ts";
import { routes } from "../routes.ts";
import { sessionStore } from "../session.ts";
import { alertStyle, buttonStyle, cardStyle, metaStyle } from "../theme.ts";
import { color } from "../tokens.ts";

export interface MyDocumentsCardProps {
  [key: string]: SerializableValue;
}

interface Summary {
  id: string;
  title: string;
  description: string;
  closesAt: string | null;
  open: boolean;
  opinionCount: number;
}

export const MyDocumentsCard = clientEntry(
  import.meta.url,
  function MyDocumentsCard(handle: Handle<MyDocumentsCardProps>) {
    let documents: Summary[] | null = null;
    let loadedFor: string | null = null;
    let error = "";

    const load = async () => {
      const userId = sessionStore.userId;
      if (!userId) {
        documents = null;
        loadedFor = null;
        handle.update();
        return;
      }
      if (loadedFor === userId) return;
      loadedFor = userId;
      try {
        const response = await sessionStore.apiFetch(
          routes.api.me.documents.href(),
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        documents = ((await response.json()) as { documents: Summary[] })
          .documents;
        error = "";
      } catch (e) {
        error = `文書を読み込めませんでした: ${(e as Error).message}`;
      }
      handle.update();
    };

    if (typeof document !== "undefined") {
      sessionStore.addEventListener("change", () => void load(), {
        signal: handle.signal,
      });
      void sessionStore.load().then(load);
    }

    return () => {
      if (!sessionStore.userId) return null;
      return (
        <section mix={cardStyle}>
          <h2>自分の文書</h2>
          {error
            ? <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
            : null}
          {documents === null
            ? <p mix={metaStyle}>読み込んでいます…</p>
            : documents.length === 0
            ? <p>まだ文書を登録していません。</p>
            : (
              <ul mix={listStyle}>
                {documents.map((doc) => (
                  <li key={doc.id}>
                    <a href={routes.document.href({ docId: doc.id })}>
                      {doc.title}
                    </a>
                    <span mix={metaStyle}>
                      {deadlineLabel(doc.closesAt, doc.open)} ・ 意見{" "}
                      {doc.opinionCount} 件
                    </span>
                  </li>
                ))}
              </ul>
            )}
          <p>
            <a href={routes.newDocument.href()} mix={buttonStyle}>
              文書を登録する
            </a>
          </p>
        </section>
      );
    };
  },
);

const listStyle = css({
  listStyle: "none",
  padding: 0,
  "& > li": {
    display: "grid",
    gap: "0.2rem",
    paddingBlock: "0.6rem",
    borderTop: `1px solid ${color.border}`,
  },
});
