import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Temporary paths handed out to tests, so a run leaves nothing behind in the
 * system temporary directory: git repositories are not small, and the seam
 * suite creates one per scenario.
 */
const created = new Set<string>();

/**
 * Creates a real git repository in a temporary directory, with one commit.
 *
 * `under` puts it in a directory of the scenario's own rather than straight in
 * the system's temporary one. A scenario that walks to it needs that: the
 * temporary directory of a machine that has run this suite holds hundreds of
 * entries, and a listing is capped.
 */
export async function createTemporaryRepository(under?: string): Promise<string> {
  const path = await mkdtemp(join(under ?? tmpdir(), "squad-repo-"));
  created.add(path);
  await run("git", ["init", "--initial-branch", "main"], { cwd: path });
  await run("git", ["config", "user.email", "squad@example.test"], { cwd: path });
  await run("git", ["config", "user.name", "Squad Test"], { cwd: path });
  await run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: path });
  return path;
}

/** Creates a temporary directory that is deliberately not a git repository. */
export async function createTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "squad-plain-"));
  created.add(path);
  return path;
}

/**
 * Adds a branch to a repository without leaving it checked out on it: a project
 * whose default branch is changed needs a second branch to change it to, and
 * moving the checkout would change what the repository is on.
 */
export async function createBranch(repository: string, branch: string): Promise<void> {
  await run("git", ["branch", branch], { cwd: repository });
}

export async function removeTemporaryPaths(): Promise<void> {
  await Promise.all([...created].map((path) => rm(path, { recursive: true, force: true })));
  created.clear();
}

/** The branch a checkout is on, which is what tells a worktree from the main one. */
export async function currentBranch(path: string): Promise<string> {
  const { stdout } = await run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: path });
  return stdout.trim();
}

/** Every branch of a repository, worktrees included, in no particular order. */
export async function listBranches(repository: string): Promise<string[]> {
  const { stdout } = await run("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: repository,
  });
  return stdout.split("\n").filter((line) => line !== "");
}

/** Every checkout git knows about: the main one first, then the worktrees. */
export async function listWorktrees(repository: string): Promise<string[]> {
  const { stdout } = await run("git", ["worktree", "list", "--porcelain"], { cwd: repository });
  return stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

/** Whether a path is on disk, which is how a kept worktree is told from a removed one. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Whether one commit-ish is reachable from another, which is what "started from" means. */
export async function isAncestor(
  repository: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await run("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repository });
    return true;
  } catch {
    return false;
  }
}

/** Writes a file in a checkout and commits it, as a sub-session would. */
export async function commitFile(
  worktree: string,
  name: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(worktree, name), content);
  await run("git", ["add", name], { cwd: worktree });
  await run("git", ["commit", "-m", message], { cwd: worktree });
}

/**
 * Merges a branch into whatever a checkout is on, and says whether it went
 * through. What a conflict resolution session does by hand, done here in one
 * line so a scripted one can play either side of it.
 */
export async function mergeInto(worktree: string, branch: string): Promise<boolean> {
  try {
    await run("git", ["merge", "--no-edit", branch], { cwd: worktree });
    return true;
  } catch {
    return false;
  }
}

/** Resolves every conflicted path to the given content, and commits the merge. */
export async function resolveConflictWith(worktree: string, content: string): Promise<void> {
  const { stdout } = await run("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: worktree });
  for (const path of stdout.split("\n").filter((line) => line !== "")) {
    await writeFile(join(worktree, path), content);
    await run("git", ["add", path], { cwd: worktree });
  }
  await run("git", ["commit", "--no-edit"], { cwd: worktree });
}

/** Leaves a checkout on no branch, which is how a branch it holds gets freed. */
export async function detach(worktree: string): Promise<void> {
  await run("git", ["checkout", "--detach"], { cwd: worktree });
}

/** Clears git's record of worktrees whose directory is gone. */
export async function pruneWorktrees(repository: string): Promise<void> {
  await run("git", ["worktree", "prune"], { cwd: repository });
}

/** Deletes a branch from a checkout, as an unconfined session may well do. */
export async function deleteBranchIn(worktree: string, branch: string): Promise<void> {
  await run("git", ["branch", "-D", branch], { cwd: worktree });
}

/** A bare repository added to a repository as its `origin`, as a forge would be. */
export async function addOrigin(repository: string): Promise<string> {
  const remote = await mkdtemp(join(tmpdir(), "squad-remote-"));
  created.add(remote);
  await run("git", ["init", "--bare", "--initial-branch", "main"], { cwd: remote });
  await run("git", ["remote", "add", "origin", remote], { cwd: repository });
  return remote;
}

/**
 * Points a repository's `origin` at an address of any shape, a forge URL among
 * them. `addOrigin` above makes a real remote to push to; this one is for when
 * what matters is how the address is written and not whether it answers.
 */
export async function setOrigin(repository: string, url: string): Promise<void> {
  await run("git", ["remote", "add", "origin", url], { cwd: repository });
}

/** The subjects of a branch's commits, newest first: what a merge really did. */
export async function commitSubjects(repository: string, branch: string): Promise<string[]> {
  const { stdout } = await run("git", ["log", "--format=%s", branch], { cwd: repository });
  return stdout.split("\n").filter((line) => line !== "");
}

/** The content of a file on a branch, or null when the branch does not hold it. */
export async function fileOnBranch(
  repository: string,
  branch: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["show", `${branch}:${path}`], { cwd: repository });
    return stdout;
  } catch {
    return null;
  }
}
