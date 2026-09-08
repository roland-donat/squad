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

/** What a merge attempt did, which is the only thing its caller decides on. */
export type MergeOutcome =
  | { merged: true }
  /**
   * Both ends touched the same lines. Told apart from any other failure by the
   * index itself rather than by what git printed: a message is a translation
   * away from meaning something else, unmerged paths are not.
   */
  | { merged: false; conflicted: true; detail: string }
  | { merged: false; conflicted: false; detail: string };

/**
 * Merges a branch into whatever a worktree is on, with a merge commit even when
 * the history would allow a fast-forward: the point of the feature branch is to
 * show which work came from which ticket, and a fast-forward erases exactly
 * that.
 *
 * A merge left half-done by a process that died is aborted first. Without it the
 * retry fails on "you have not concluded your merge", which says nothing about
 * the branches and sends the reader looking at the wrong thing.
 */
export async function mergeBranch(
  worktreePath: string,
  branch: string,
  message: string,
): Promise<MergeOutcome> {
  await abortMergeInProgress(worktreePath);
  try {
    await run("git", ["merge", "--no-ff", "-m", message, branch], { cwd: worktreePath });
    return { merged: true };
  } catch (cause) {
    const detail = reasonOf(cause);
    if (!(await hasUnmergedPaths(worktreePath))) return { merged: false, conflicted: false, detail };
    // Left clean whatever happens next: a conflict is resolved on the ticket's
    // own branch, and a feature worktree sitting on an unfinished merge would
    // refuse every other merge queued behind this one.
    await abortMergeInProgress(worktreePath);
    return { merged: false, conflicted: true, detail };
  }
}

/** Whether a merge is under way in this worktree, and undoing it if so. */
async function abortMergeInProgress(worktreePath: string): Promise<void> {
  if (!(await hasUnmergedPaths(worktreePath))) return;
  try {
    await run("git", ["merge", "--abort"], { cwd: worktreePath });
  } catch {
    // Nothing to abort after all: the index held unmerged paths for another
    // reason, and the merge below will say so far better than a guess here.
  }
}

async function hasUnmergedPaths(worktreePath: string): Promise<boolean> {
  const { stdout } = await run("git", ["ls-files", "--unmerged"], { cwd: worktreePath });
  return stdout.trim() !== "";
}

/**
 * Removes a checkout squad made, and the administrative entry that goes with
 * it. Forced, because a sub-session leaves build output and ignored files
 * behind it and none of that is a reason to keep a merged worktree on disk.
 */
export async function removeWorktree(repositoryRoot: string, path: string): Promise<void> {
  await git(repositoryRoot, ["worktree", "remove", "--force", path]);
}

/**
 * Deletes a branch whose work is merged. `-d` rather than `-D`: it refuses on a
 * branch holding something the target does not, which is the one case where
 * losing the branch would lose work.
 *
 * Run from the checkout the work was merged into, and not from the main one:
 * what `-d` calls merged is merged into that checkout's own HEAD, so asking the
 * main checkout, which never leaves the default branch, refuses every ticket
 * branch there is.
 */
export async function deleteBranch(worktreePath: string, branch: string): Promise<void> {
  await git(worktreePath, ["branch", "-d", branch]);
}

/** Whether the repository knows a remote under this name. */
export async function hasRemote(repositoryRoot: string, remote: string): Promise<boolean> {
  const { stdout } = await run("git", ["remote"], { cwd: repositoryRoot });
  return stdout.split("\n").some((line) => line.trim() === remote);
}

/**
 * Publishes a branch on a remote, and sets it as upstream: what the forge is
 * asked about afterwards is named by that branch, and a branch with no upstream
 * is one `gh` cannot find.
 */
export async function pushBranch(
  repositoryRoot: string,
  remote: string,
  branch: string,
): Promise<void> {
  await git(repositoryRoot, ["push", "--set-upstream", remote, branch]);
}
