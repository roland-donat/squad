import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { SquadError } from "./errors";

const run = promisify(execFile);

export interface GitRepository {
  /** Absolute, symlink-resolved path of the repository root. */
  root: string;
  /** Branch HEAD points at, which squad records as the project's default branch. */
  currentBranch: string;
}

/**
 * Resolves a path given by the pilot into a repository squad can drive. A path
 * inside a repository resolves to that repository's root, so the same project
 * cannot be registered twice under two different paths.
 */
export async function inspectGitRepository(path: string): Promise<GitRepository> {
  let resolved: string;
  try {
    const entry = await stat(path);
    if (!entry.isDirectory()) {
      throw new SquadError("not_a_git_repository", 400, `${path} is not a directory`);
    }
    resolved = await realpath(path);
  } catch (cause) {
    if (cause instanceof SquadError) throw cause;
    throw new SquadError("path_not_found", 400, `${path} does not exist`);
  }

  let root: string;
  try {
    const { stdout } = await run("git", ["rev-parse", "--show-toplevel"], { cwd: resolved });
    root = await realpath(stdout.trim());
  } catch {
    throw new SquadError("not_a_git_repository", 400, `${path} is not a git repository`);
  }

  return { root, currentBranch: await readCurrentBranch(root) };
}

/**
 * `symbolic-ref` rather than `rev-parse --abbrev-ref`, because it still answers
 * on a repository that has no commit yet. A detached HEAD has no branch name to
 * report, and falls back to the conventional default.
 */
async function readCurrentBranch(root: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["symbolic-ref", "--short", "HEAD"], { cwd: root });
    return stdout.trim() || "main";
  } catch {
    return "main";
  }
}
