import { useState, type FormEvent } from "react";
import type { Feature, ThreadEntry } from "../../shared/api";
import { ApiError, sendMainSessionMessage, startMainSession } from "../api";
import { Thread } from "./Thread";

/**
 * The thread of a feature's main session, and the one box that both opens it and
 * writes to it. This is where the spec is pasted, the breakdown adjusted and the
 * decisions settled; the tickets themselves are built elsewhere.
 */

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
      <Thread
        entries={thread}
        empty={
          <>
            Fil vide. Coller le spec puis lancer <code>/to-tickets</code> pour faire naître le
            graphe.
          </>
        }
      />
      <Composer feature={feature} running={running} />
    </>
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
