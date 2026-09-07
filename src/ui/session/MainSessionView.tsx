import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Feature, ThreadEntry, ThreadEntryKind } from "../../shared/api";
import { ApiError, sendMainSessionMessage, startMainSession } from "../api";

/**
 * The thread of a feature's main session: what the developer typed, what the
 * agent said, and what it called. The agent's text is shown as it comes; a tool
 * call is folded away behind its name, because the graph already shows what a
 * call to squad wrote and the prose is what has to stay readable.
 */

const kindLabels: Record<ThreadEntryKind, string> = {
  pilot: "moi",
  agent: "agent",
  tool: "outil",
  notice: "squad",
};

export function MainSessionView({
  feature,
  thread,
  running,
}: {
  feature: Feature;
  thread: ThreadEntry[];
  running: boolean;
}) {
  return (
    <>
      <p className="panel__context">
        de <strong>{feature.title}</strong>
        <span className={running ? "badge badge--live" : "badge"}>
          {running ? "en cours" : "arrêtée"}
        </span>
      </p>
      <Thread entries={thread} />
      <Composer feature={feature} running={running} />
    </>
  );
}

function Thread({ entries }: { entries: ThreadEntry[] }) {
  const bottom = useRef<HTMLDivElement>(null);
  // Follows the session as it writes, which is the whole point of watching a
  // thread: the newest line is the one being read.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);

  if (entries.length === 0) {
    return (
      <p className="empty">
        Fil vide. Coller le spec puis lancer <code>/to-tickets</code> pour faire naître le graphe.
      </p>
    );
  }

  return (
    <ol className="thread">
      {entries.map((entry) => (
        <li key={entry.id} className="thread__entry" data-kind={entry.kind}>
          <span className="thread__who">{kindLabels[entry.kind]}</span>
          {entry.kind === "tool" ? (
            <details className="thread__tool">
              <summary>{entry.text}</summary>
              <pre>{entry.detail ?? "sans argument"}</pre>
            </details>
          ) : (
            <p className="thread__text">{entry.text}</p>
          )}
        </li>
      ))}
      <div ref={bottom} />
    </ol>
  );
}

/**
 * One box for both cases. Opening the session and writing to it are the same
 * gesture for the developer, so they are the same field here: the difference is
 * which request the message goes out on.
 */
function Composer({ feature, running }: { feature: Feature; running: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (running) await sendMainSessionMessage(feature.id, { text });
      else await startMainSession(feature.id, { prompt: text });
      setText("");
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form composer" onSubmit={submit}>
      <label className="field">
        <span>{running ? "Message à la session" : "Premier message de la session"}</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="/to-tickets sur le spec collé plus haut"
          rows={4}
          required
        />
      </label>
      <button type="submit" disabled={busy}>
        {running ? "Envoyer" : "Ouvrir la session principale"}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
