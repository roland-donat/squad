import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { CommandFailure, runCommand } from "./command";
import { SquadError } from "./errors";

/**
 * Resolves a path into the git repository squad would drive, and returns its
 * root: absolute and free of symlinks. A path inside a repository resolves to
 * that repository's root, so the same project cannot be registered twice under
 * two different paths.
 */
export async function resolveRepositoryRoot(path: string): Promise<string> {
  const readable = await inspectPath(path);
  try {
    const root = await runCommand(readable, "git", ["rev-parse", "--show-toplevel"]);
    return await realpath(root.trim());
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
    const head = await runCommand(repositoryRoot, "git", ["symbolic-ref", "--short", "HEAD"]);
    return head.trim();
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

/**
 * Whether a branch is there. Asked before a project is told to start its feature
 * branches from one: a default branch that does not exist fails nowhere until
 * the first feature is launched, and then fails as a git error nobody can read.
 */
export async function branchExists(repositoryRoot: string, branch: string): Promise<boolean> {
  try {
    await runCommand(repositoryRoot, "git", [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** The commit a branch points at, or null when the branch is not there. */
export async function branchHead(worktreePath: string, branch: string): Promise<string | null> {
  try {
    return (await runCommand(worktreePath, "git", ["rev-parse", "--verify", `${branch}^{commit}`]))
      .trim();
  } catch {
    return null;
  }
}

/**
 * Whether `commit` is already an ancestor of the branch checked out here, which
 * is git's own answer to "is this work in".
 *
 * Squad asks it rather than deducing it from its own merge having succeeded: a
 * conflict resolution session is not confined (ADR 0004), and one that carries
 * the merge through itself leaves squad's retry with nothing to merge and a
 * branch that may be gone. What decides whether a ticket landed is the state of
 * the tree, never whose command put it there.
 */
export async function isMergedInto(worktreePath: string, commit: string): Promise<boolean> {
  try {
    await runCommand(worktreePath, "git", ["merge-base", "--is-ancestor", commit, "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A git command squad runs on a repository it drives. Its failure comes back as
 * a squad error carrying what git said and where: a worktree that could not be
 * created is something the developer has to read, not a stack trace.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  try {
    return await runCommand(cwd, "git", args);
  } catch (cause) {
    const said = cause instanceof CommandFailure ? cause.reason : String(cause);
    throw new SquadError("git_failed", 500, `git ${args.join(" ")} failed in ${cwd}: ${said}`);
  }
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
    await runCommand(worktreePath, "git", ["merge", "--no-ff", "-m", message, branch]);
    return { merged: true };
  } catch (cause) {
    const detail = cause instanceof CommandFailure ? cause.reason : String(cause);
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
    await runCommand(worktreePath, "git", ["merge", "--abort"]);
  } catch {
    // Nothing to abort after all: the index held unmerged paths for another
    // reason, and the merge below will say so far better than a guess here.
  }
}

async function hasUnmergedPaths(worktreePath: string): Promise<boolean> {
  const unmerged = await runCommand(worktreePath, "git", ["ls-files", "--unmerged"]);
  return unmerged.trim() !== "";
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
  const remotes = await runCommand(repositoryRoot, "git", ["remote"]);
  return remotes.split("\n").some((line) => line.trim() === remote);
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
