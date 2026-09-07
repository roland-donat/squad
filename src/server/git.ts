import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { SquadError } from "./errors";

const run = promisify(execFile);

/**
 * Resolves a path into the git repository squad would drive, and returns its
 * root: absolute and free of symlinks. A path inside a repository resolves to
 * that repository's root, so the same project cannot be registered twice under
 * two different paths.
 */
export async function resolveRepositoryRoot(path: string): Promise<string> {
  const readable = await inspectPath(path);
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: readable });
    return await realpath(stdout.trim());
  } catch {
    throw new SquadError("not_a_git_repository", 400, `${path} is not a git repository`);
  }
}

/**
 * Tells a missing path from an unreadable one: reporting a permission failure
 * as an absent directory sends the reader looking for the wrong problem.
 */
async function inspectPath(path: string): Promise<string> {
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) {
      throw new SquadError("not_a_git_repository", 400, `${path} is not a directory`);
    }
    return await realpath(path);
  } catch (cause) {
    if (cause instanceof SquadError) throw cause;
    if (isSystemError(cause) && cause.code === "ENOENT") {
      throw new SquadError("path_not_found", 400, `${path} does not exist`);
    }
    const reason = isSystemError(cause) ? cause.code : "unknown error";
    throw new SquadError("path_not_readable", 400, `${path} cannot be read: ${reason}`);
  }
}

function isSystemError(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause;
}
