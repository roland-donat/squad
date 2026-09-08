import { useEffect, useState } from "react";
import type { Feature, Project, RecordedSession } from "../../shared/api";
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
export function RecordedSessions({
  projects,
  onAttached,
}: {
  /** What squad already drives, which is what tells a click that registers. */
  projects: Project[];
  onAttached: (feature: Feature) => void;
}) {
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<RecordedSession[] | null>(null);
  const [matching, setMatching] = useState(0);
  const [readable, setReadable] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    // Left to settle before asking: a search is typed letter by letter, and
    // each letter would otherwise walk every conversation on the machine.
    const waiting = setTimeout(() => {
      listRecordedSessions(search)
        .then((found) => {
          if (current) {
            setSessions(found.sessions);
            setMatching(found.matching);
            setReadable(found.readable);
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
          {!readable
            ? "Squad n'a pas pu lire le dossier des conversations de claude-code : il n'existe pas, ou il n'est pas lisible."
            : search.trim() === ""
              ? "Aucune conversation enregistrée sur cette machine."
              : "Aucune conversation ne correspond."}
        </p>
      ) : (
        <>
          {matching > sessions.length && (
            // Never a cap kept quiet: a reader who cannot see the other twenty
            // would read their search as narrower than it is.
            <p className="empty">
              {sessions.length} conversations sur {matching}. Préciser la recherche pour voir
              les autres.
            </p>
          )}
          <ul className="list">
            {sessions.map((session) => (
              <RecordedRow
                key={session.id}
                session={session}
                known={projects.some((project) => project.path === session.repository)}
                onAttached={onAttached}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RecordedRow({
  session,
  known,
  onAttached,
}: {
  session: RecordedSession;
  /** Whether squad already drives the repository this conversation ran in. */
  known: boolean;
  onAttached: (feature: Feature) => void;
}) {
  const { busy, error, run } = useSubmission(async () => {
    onAttached(await attachRecordedSession(session.id));
  });

  return (
    <li className="recorded">
      <span className="row__title">{session.title ?? session.firstMessage ?? session.cwd}</span>
      <span className="row__detail">
        {session.repository ?? session.cwd}
        {session.branch === null ? "" : ` · ${session.branch}`}
      </span>
      <span className="row__meta">
        {new Date(session.recordedAt).toLocaleString("fr-FR")} · {sizeOf(session.bytes)}
        {known ? "" : " · dépôt pas encore enregistré"}
      </span>
      {/* What the click will do, said before it is clicked: attaching a
          conversation of a repository squad does not drive is first of all
          handing it that repository. */}
      <button type="button" disabled={busy} onClick={() => void run()}>
        {known ? "Rattacher" : "Enregistrer le dépôt et rattacher"}
      </button>
      <Failure message={error} />
    </li>
  );
}

/**
 * How big a conversation is, which is what the reader decides on: resuming one
 * of several tens of megabytes is paid for at its first turn.
 */
function sizeOf(bytes: number): string {
  const mega = bytes / 1_048_576;
  return mega >= 1 ? `${mega.toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} ko`;
}
