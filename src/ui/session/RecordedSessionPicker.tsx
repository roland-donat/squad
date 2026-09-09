import { useEffect, useState } from "react";
import type { Project, RecordedSession } from "../../shared/api";
import { ApiError, listRecordedSessions } from "../api";
import { Failure } from "../submission";

/**
 * The conversations claude-code has already recorded, and the one that is being
 * resumed. The grilling and the spec are written at the terminal by design:
 * this is the door between that work and the graph, so that a feature starts
 * from what was already said rather than from a spec pasted again by hand.
 *
 * It picks and nothing more. What a conversation is turned into is decided on
 * the form around it, which asks the same questions of a feature started from
 * nothing: the door a feature came through changes where its thread starts, not
 * what it is configured with.
 *
 * The ten most recent are shown, and the search finds the others. It reads what
 * identifies a conversation, the repository, the branch, the title and the first
 * thing asked; what was said in it is never read, here or anywhere else.
 */
export function RecordedSessionPicker({
  projects,
  chosen,
  onChoose,
}: {
  /** What squad already drives, which is what tells a row it needs no handing over. */
  projects: Project[];
  chosen: RecordedSession | null;
  onChoose: (session: RecordedSession) => void;
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
    <div className="picker">
      <label className="field">
        <span>Rechercher une conversation</span>
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
              {sessions.length} conversations sur {matching}. Préciser la recherche pour voir les
              autres.
            </p>
          )}
          <ul className="list">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={session.id === chosen?.id ? "row row--selected" : "row"}
                  aria-current={session.id === chosen?.id}
                  onClick={() => onChoose(session)}
                >
                  <span className="row__title">
                    {session.title ?? session.firstMessage ?? session.cwd}
                  </span>
                  <span className="row__detail">
                    {session.repository ?? session.cwd}
                    {session.branch === null ? "" : ` · ${session.branch}`}
                  </span>
                  <span className="row__meta">
                    {new Date(session.recordedAt).toLocaleString("fr-FR")} ·{" "}
                    {sizeOf(session.bytes)}
                    {/* Said before it is chosen: resuming a conversation of a
                        repository squad does not drive is first of all handing
                        it that repository. */}
                    {projects.some((project) => project.path === session.repository)
                      ? ""
                      : " · dépôt pas encore enregistré"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
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
