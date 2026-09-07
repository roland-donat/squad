import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
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

/** Creates a real git repository in a temporary directory, with one commit. */
export async function createTemporaryRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "squad-repo-"));
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
