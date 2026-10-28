/** How dates read on this site: Japanese, local time, to the minute. */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "締切 …" / "募集終了" / "期限なし" for a document's deadline. */
export function deadlineLabel(closesAt: string | null, open: boolean): string {
  if (!open) return "募集終了";
  return closesAt ? `${formatDateTime(closesAt)} まで募集` : "期限なし";
}
