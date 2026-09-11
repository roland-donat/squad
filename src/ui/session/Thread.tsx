import { useEffect, useRef } from "react";
import type { ThreadEntry, ThreadEntryKind } from "../../shared/api";
import { Markdown } from "../markdown/Markdown";

/**
 * The thread of a session, whichever kind: what the developer asked for, what
 * the agent said, what it called, and what squad reported about the session
 * itself. The agent's prose is the thing to read, so a tool call is folded away
 * behind its name; the graph already shows what a call to squad wrote.
 */

const kindLabels: Record<ThreadEntryKind, string> = {
  pilot: "moi",
  agent: "agent",
  tool: "outil",
  notice: "squad",
};

export function Thread({ entries, empty }: { entries: ThreadEntry[]; empty: React.ReactNode }) {
  const list = useRef<HTMLOListElement>(null);
  // Follows the session as it writes, which is the whole point of watching a
  // thread: the newest line is the one being read. The list scrolls itself
  // rather than the newest line scrolling the page under the reader.
  useEffect(() => {
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [entries.length]);

  if (entries.length === 0) return <p className="empty">{empty}</p>;

  return (
    <ol className="thread" ref={list}>
      {entries.map((entry) => (
        <li key={entry.id} className="thread__entry" data-kind={entry.kind}>
          <span className="thread__who">{kindLabels[entry.kind]}</span>
          {entry.kind === "tool" ? (
            <details className="thread__tool">
              <summary>{entry.text}</summary>
              <pre>{entry.detail ?? "sans argument"}</pre>
            </details>
          ) : (
            <Markdown text={entry.text} subset="full" className="thread__text" />
          )}
          {entry.kind === "notice" && entry.detail !== null && (
            <pre className="thread__detail">{entry.detail}</pre>
          )}
        </li>
      ))}
    </ol>
  );
}
