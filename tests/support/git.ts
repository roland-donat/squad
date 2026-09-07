import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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
