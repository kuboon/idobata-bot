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

/** A moment as a `datetime-local` value, in local time, to the minute. */
export function localInputValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${
    pad(at.getHours())
  }:${pad(at.getMinutes())}`;
}

/**
 * The default deadline for a new document: midnight at the start of the day one month from now,
 * as a `datetime-local` value (local time). A month ahead of the 31st lands on the next month's
 * last day rather than spilling over.
 *
 * @param now The moment to count from
 */
export function defaultDeadline(now = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return localInputValue(
    new Date(year, month, Math.min(now.getDate(), lastDay)),
  );
}
