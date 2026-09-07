import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
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

/**
 * The branch a repository is on, which is the branch squad takes as its default:
 * the one feature branches start from, and the one the main checkout is never
 * moved off. Read once, at registration, and stored on the project.
 */
export async function resolveDefaultBranch(repositoryRoot: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["symbolic-ref", "--short", "HEAD"], {
      cwd: repositoryRoot,
    });
    return stdout.trim();
  } catch {
    throw new SquadError(
      "detached_head",
      400,
      `${repositoryRoot} is not on a branch: squad needs a default branch to start feature branches from`,
    );
  }
}

export interface WorktreeRequest {
  repositoryRoot: string;
  /** Where the checkout goes; squad never puts one inside the repository. */
  path: string;
  branch: string;
  /** Where the branch starts. Ignored when the branch already exists. */
  startPoint: string;
}

/**
 * Checks a branch out in a worktree of its own, creating the branch when it is
 * not there yet. Nothing about this touches the main checkout, which is the
 * whole point: what points at the repository keeps serving what it served.
 *
 * An existing branch is checked out as it stands rather than recreated, so a
 * ticket whose worktree was cleaned off the disk comes back onto the work its
 * branch already holds.
 */
export async function createWorktree(request: WorktreeRequest): Promise<void> {
  const { repositoryRoot, path, branch, startPoint } = request;
  await mkdir(dirname(path), { recursive: true });
  // Clears the administrative entries of worktrees whose directory is gone.
  // Without it, recreating one squad recorded is refused as a duplicate of a
  // checkout that no longer exists anywhere but in git's own bookkeeping.
  await git(repositoryRoot, ["worktree", "prune"]);
  await git(
    repositoryRoot,
    (await branchExists(repositoryRoot, branch))
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, startPoint],
  );
}

async function branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  try {
    await run("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repositoryRoot,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A git command squad runs on a repository it drives. Its failure comes back as
 * a squad error carrying what git said: a worktree that could not be created is
 * something the developer has to read, not a stack trace.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd });
    return stdout;
  } catch (cause) {
    throw new SquadError("git_failed", 500, `git ${args.join(" ")} failed in ${cwd}: ${reasonOf(cause)}`);
  }
}

function reasonOf(cause: unknown): string {
  if (cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string") {
    const said = cause.stderr.trim();
    if (said !== "") return said;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
