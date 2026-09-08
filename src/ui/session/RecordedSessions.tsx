import { useEffect, useState } from "react";
import type { Feature, RecordedSession } from "../../shared/api";
import { ApiError, attachRecordedSession, listRecordedSessions } from "../api";
import { Failure, useSubmission } from "../submission";

/**
 * The conversations claude-code has already recorded, and the one gesture that
 * turns one into a feature. The grilling and the spec are written at the
 * terminal by design: this is the door between that work and the graph, so that
 * a feature starts from what was already said rather than from a spec pasted
 * again by hand.
 *
 * The ten most recent are shown, and the search finds the others. It reads what
 * identifies a conversation, the repository, the branch, the title and the first
 * thing asked; what was said in it is never read, here or anywhere else.
 */
export function RecordedSessions({ onAttached }: { onAttached: (feature: Feature) => void }) {
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<RecordedSession[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    // Left to settle before asking: a search is typed letter by letter, and
    // each letter would otherwise walk every conversation on the machine.
    const waiting = setTimeout(() => {
      listRecordedSessions(search)
        .then((found) => {
          if (current) {
            setSessions(found);
            setFailure(null);
          }
        })
        .catch((error: unknown) => {
          if (!current) return;
          setSessions([]);
          setFailure(error instanceof ApiError ? error.message : "Le serveur est injoignable.");
        });
    }, 200);
    return () => {
      current = false;
      clearTimeout(waiting);
    };
  }, [search]);

  return (
    <section className="panel panel--recorded" aria-labelledby="titre-sessions">
      <h2 id="titre-sessions">Reprendre une session</h2>
      <p className="panel__context">
        Les conversations claude-code de cette machine. En rattacher une ouvre une feature dont
        le fil est cette conversation, reprise.
      </p>
      <label className="field">
        <span>Rechercher une session</span>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="un dépôt, une branche, un titre, un premier message"
        />
      </label>
      <Failure message={failure} />
      {sessions === null ? (
        <p className="empty">Lecture des conversations enregistrées.</p>
      ) : sessions.length === 0 ? (
        <p className="empty">
          {search.trim() === ""
            ? "Aucune conversation enregistrée sur cette machine."
            : "Aucune conversation ne correspond."}
        </p>
      ) : (
        <ul className="list">
          {sessions.map((session) => (
            <RecordedRow key={session.id} session={session} onAttached={onAttached} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecordedRow({
  session,
  onAttached,
}: {
  session: RecordedSession;
  onAttached: (feature: Feature) => void;
}) {
  const { busy, error, run } = useSubmission(async () => {
    onAttached(await attachRecordedSession(session.id));
  });

  return (
    <li className="recorded">
      <span className="row__title">{session.title ?? session.firstMessage ?? session.cwd}</span>
      <span className="row__detail">
        {session.cwd}
        {session.branch === null ? "" : ` · ${session.branch}`}
      </span>
      <span className="row__meta">
        {new Date(session.recordedAt).toLocaleString("fr-FR")} · {sizeOf(session.bytes)}
      </span>
      <button type="button" disabled={busy} onClick={() => void run()}>
        Rattacher
      </button>
      <Failure message={error} />
    </li>
  );
}

/**
 * How big a conversation is, said in what the reader decides on: reprendre une
 * conversation de plusieurs dizaines de mégaoctets se paie au premier tour.
 */
function sizeOf(bytes: number): string {
  const mega = bytes / 1_048_576;
  return mega >= 1 ? `${mega.toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} ko`;
}
