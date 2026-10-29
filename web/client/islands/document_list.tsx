/**
 * DocumentList — the home page's list of every document, from `GET /api/docs`: the open ones,
 * then the closed ones, each by deadline, soonest first (no deadline last).
 *
 * An island rather than server-rendered HTML because the page is static: the build writes `/`
 * once, and the documents are only in the database.
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
import { alertStyle, cardStyle, metaStyle } from "../theme.ts";

export interface DocumentListProps {
  [key: string]: SerializableValue;
}

interface Summary {
  id: string;
  title: string;
  description: string;
  owner: { nickname: string };
  closesAt: string | null;
  open: boolean;
  opinionCount: number;
}

/** Soonest deadline first; documents without one last, newest of them first as the API sends. */
function byDeadline(documents: Summary[]): Summary[] {
  return documents
    .map((doc, i) => ({ doc, i }))
    .sort((a, b) =>
      a.doc.closesAt && b.doc.closesAt
        ? a.doc.closesAt.localeCompare(b.doc.closesAt)
        : a.doc.closesAt
        ? -1
        : b.doc.closesAt
        ? 1
        : a.i - b.i
    )
    .map(({ doc }) => doc);
}

/** One document in the list. */
const item = (doc: Summary) => (
  <li key={doc.id} mix={cardStyle}>
    <h3 mix={titleStyle}>
      <a href={routes.document.href({ docId: doc.id })}>{doc.title}</a>
    </h3>
    {doc.description ? <p>{doc.description}</p> : null}
    <span mix={metaStyle}>
      {deadlineLabel(doc.closesAt, doc.open)} ・ 意見 {doc.opinionCount} 件 ・
      {" "}
      {doc.owner.nickname}
    </span>
  </li>
);

export const DocumentList = clientEntry(
  import.meta.url,
  function DocumentList(handle: Handle<DocumentListProps>) {
    let documents: Summary[] | null = null;
    let error = "";

    if (typeof document !== "undefined") {
      void (async () => {
        try {
          const response = await sessionStore.apiFetch(
            routes.api.docs.index.href(),
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          documents = ((await response.json()) as { documents: Summary[] })
            .documents;
        } catch (e) {
          error = `文書の一覧を読み込めませんでした: ${(e as Error).message}`;
        }
        handle.update();
      })();
    }

    return () => {
      if (error) {
        return (
          <div role="alert" data-kind="error" mix={alertStyle}>{error}</div>
        );
      }
      if (documents === null) return <p mix={metaStyle}>読み込んでいます…</p>;
      if (documents.length === 0) {
        return <p>登録済みの文書はまだありません。</p>;
      }
      const open = byDeadline(documents.filter((d) => d.open));
      const closed = byDeadline(documents.filter((d) => !d.open));
      return (
        <>
          <h2>募集中</h2>
          {open.length === 0
            ? <p mix={metaStyle}>いま募集中の文書はありません。</p>
            : <ul mix={listStyle}>{open.map(item)}</ul>}
          {closed.length === 0 ? null : (
            <>
              <h2>募集終了</h2>
              <ul mix={listStyle}>{closed.map(item)}</ul>
            </>
          )}
        </>
      );
    };
  },
);

const listStyle = css({
  listStyle: "none",
  padding: 0,
  "& > li": { marginBlock: "1rem" },
});

const titleStyle = css({ marginBlock: "0 0.5rem", fontSize: "1.15rem" });
