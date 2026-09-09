import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { DirectoryEntry, DirectoryListing } from "../shared/api";
import { SquadError } from "./errors";
import { repositoryName } from "./git";

/**
 * Walking the machine's directories, one step at a time, so a repository can be
 * chosen rather than typed from memory.
 *
 * It is squad's own route and not the browser's file picker on purpose: an
 * `<input type="file" webkitdirectory>` hands back file names and never a real
 * path on disk, which is a guarantee of the browser rather than a gap in it. So
 * the rule holds unchanged, the browser never touches the disk (ADR 0005), and
 * squad reads on its behalf.
 *
 * This is the first route that gives away the shape of the filesystem, which is
 * worth saying out loud rather than discovering later. It does not change what
 * squad is exposed to: squad listens on the loopback only and has neither
 * accounts nor authentication, by a decision taken in the open, because it runs
 * on its user's own machine. The route reads, returns directory names and
 * nothing else, and never descends of its own accord.
 */

/** How deep a listing goes, said as a number so nobody has to guess: one step. */
export async function listDirectory(asked: string | undefined): Promise<DirectoryListing> {
  // No path is not an error: it is the first step, and the home directory is
  // the one place a walk with nothing to go on can honestly start from.
  const target = asked ?? homedir();
  if (!isAbsolute(target)) {
    throw new SquadError(
      "invalid_request",
      400,
      `${target} is not an absolute path: a walk starts from somewhere named in full`,
    );
  }
  const path = await resolveDirectory(target);
  const [entries, isRepository] = await Promise.all([readEntries(path), holdsRepository(path)]);

  return {
    path,
    // Up, until up is where one already is, which is only true of the root.
    parent: dirname(path) === path ? null : dirname(path),
    isRepository,
    suggestedName: isRepository ? await repositoryName(path) : null,
    entries,
  };
}

/**
 * The directory this path names, free of symlinks. Missing, unreadable and not
 * a directory are told apart: reporting a permission failure as an absent
 * directory sends the reader looking for the wrong problem, which is the same
 * reason `git.ts` tells them apart when a project is registered.
 */
async function resolveDirectory(path: string): Promise<string> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) {
      throw new SquadError("invalid_request", 400, `${path} is not a directory`);
    }
    return await realpath(path);
  } catch (cause) {
    if (cause instanceof SquadError) throw cause;
    throw failureOf(path, cause);
  }
}

/**
 * The directories inside, by name. Read with the entry types the system already
 * knows, so nothing is opened to find out what it is; a symlink is the one that
 * has to be asked about, since the type it carries is its own and not that of
 * what it points at, and a broken one is passed over rather than reported.
 */
async function readEntries(path: string): Promise<DirectoryEntry[]> {
  let read;
  try {
    read = await readdir(path, { withFileTypes: true });
  } catch (cause) {
    throw failureOf(path, cause);
  }

  const kept = await Promise.all(
    read
      .filter((entry) => !entry.name.startsWith("."))
      .map(async (entry) => {
        const child = join(path, entry.name);
        if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await leadsToDirectory(child)))) {
          return null;
        }
        return { name: entry.name, path: child, isRepository: await holdsRepository(child) };
      }),
  );

  return kept
    .filter((entry): entry is DirectoryEntry => entry !== null)
    .sort((one, other) => one.name.localeCompare(other.name, "fr"));
}

async function leadsToDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    // A link pointing at nothing, or at something squad may not look at: not a
    // directory to offer, and not a reason to fail the step it appears in.
    return false;
  }
}

/**
 * Whether a repository sits here. Read off `.git`, which costs one look, rather
 * than by asking git, which would cost a process per entry and would say yes
 * inside a repository as well as at its top.
 *
 * A file counts as much as a directory: that is what a worktree leaves behind,
 * and squad's own worktrees are exactly that.
 */
async function holdsRepository(path: string): Promise<boolean> {
  try {
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

/** What a system error means for the reader, told apart rather than lumped. */
function failureOf(path: string, cause: unknown): SquadError {
  const code = cause instanceof Error && "code" in cause ? String(cause.code) : "unknown error";
  if (code === "ENOENT") {
    return new SquadError("path_not_found", 400, `${path} does not exist`);
  }
  if (code === "ENOTDIR") {
    return new SquadError("invalid_request", 400, `${path} is not a directory`);
  }
  return new SquadError("path_not_readable", 400, `${path} cannot be read: ${code}`);
}
