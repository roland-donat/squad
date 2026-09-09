import { useEffect, useState } from "react";
import type { DirectoryListing } from "../../shared/api";
import { ApiError, listDirectory } from "../api";
import { Dialog } from "../Dialog";
import { Failure } from "../submission";

/**
 * Choosing a repository by walking to it, rather than typing its absolute path
 * from memory.
 *
 * The walk is squad's own route and not the browser's file picker: an
 * `<input type="file" webkitdirectory>` hands back file names and never a real
 * path on disk, which is a guarantee of the browser rather than a gap in it. So
 * the browser still never touches the disk (ADR 0005) and squad reads for it.
 *
 * What comes back is a path and a name: the name a repository carries on its
 * forge when it has an `origin`, the directory's own otherwise. Proposed and
 * never imposed, since the field it lands in stays a field.
 */

/** Where the last walk ended, so the next one does not start from nowhere. */
const lastWalk = "squad.last-directory";

export function DirectoryPicker({
  label,
  onChoose,
}: {
  /** What the button says, since it fills a field the caller names. */
  label: string;
  onChoose: (chosen: { path: string; suggestedName: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="button--secondary" onClick={() => setOpen(true)}>
        {label}
      </button>
      <Dialog title="Choisir un dépôt" open={open} onClose={() => setOpen(false)}>
        <Walk
          onChoose={(chosen) => {
            remember(chosen.path);
            onChoose(chosen);
            setOpen(false);
          }}
        />
      </Dialog>
    </>
  );
}

function remember(path: string): void {
  try {
    window.localStorage.setItem(lastWalk, path);
  } catch {
    // A browser refusing storage costs the next walk its starting point and
    // nothing else: it must not take the dialog down with it.
  }
}

function rememberedWalk(): string | undefined {
  try {
    return window.localStorage.getItem(lastWalk) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The walk itself. One step at a time, and a step that fails costs the step and
 * not the walk: a directory squad may not read says so and leaves the listing
 * where it was, which is the only place from which one can carry on.
 */
function Walk({ onChoose }: { onChoose: (chosen: DirectoryListing) => void }) {
  const [here, setHere] = useState<DirectoryListing | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  // Where to walk to next. Null on the first render means "wherever squad
  // starts", which is the home directory, and the remembered path when there is
  // one: a walk that begins at the root of the filesystem begins nowhere useful.
  const [going, setGoing] = useState<string | undefined>(rememberedWalk);

  useEffect(() => {
    let current = true;
    listDirectory(going)
      .then((listing) => {
        if (!current) return;
        setHere(listing);
        setRefused(null);
      })
      .catch((failure: unknown) => {
        if (!current) return;
        setRefused(failure instanceof ApiError ? failure.message : "Le serveur est injoignable.");
        // Left where it was rather than emptied: a refusal is a step not taken.
        // On the very first one there is nowhere to stay, so squad's own
        // starting point takes over, which is what a remembered path that has
        // since been removed comes down to.
        if (here === null && going !== undefined) setGoing(undefined);
      });
    return () => {
      current = false;
    };
  }, [going]);

  if (here === null) {
    return (
      <>
        <p className="empty">Lecture des répertoires.</p>
        <Failure message={refused} />
      </>
    );
  }

  return (
    <>
      <p className="walk__here">
        <span className="walk__path">{here.path}</span>
        {here.isRepository && <span className="walk__mark">dépôt git</span>}
      </p>
      <Failure message={refused} />

      <ul className="list walk__entries">
        {here.parent !== null && (
          <li>
            <button type="button" className="row" onClick={() => setGoing(here.parent ?? undefined)}>
              <span className="row__title">.. remonter</span>
            </button>
          </li>
        )}
        {here.entries.map((entry) => (
          <li key={entry.path}>
            <button type="button" className="row" onClick={() => setGoing(entry.path)}>
              <span className="row__title">
                {entry.name}
                {entry.isRepository && <span className="walk__mark">dépôt git</span>}
              </span>
            </button>
          </li>
        ))}
        {here.entries.length === 0 && <li className="empty">Aucun répertoire ici.</li>}
      </ul>

      <div className="walk__actions">
        <button type="button" onClick={() => onChoose(here)}>
          Choisir ce répertoire
        </button>
        {/* Said rather than forbidden: squad resolves a path inside a repository
            to that repository's root, so choosing here is not a mistake, and a
            directory that is not one at all is refused by the registration with
            a message of its own. */}
        {!here.isRepository && (
          <span className="row__meta">Ce répertoire ne porte pas de dépôt git.</span>
        )}
      </div>
    </>
  );
}
