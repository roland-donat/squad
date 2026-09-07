import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Creates a real git repository in a temporary directory, with one commit. */
export async function createTemporaryRepository(branch = "main"): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "squad-repo-"));
  await run("git", ["init", "--initial-branch", branch], { cwd: path });
  await run("git", ["config", "user.email", "squad@example.test"], { cwd: path });
  await run("git", ["config", "user.name", "Squad Test"], { cwd: path });
  await run("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: path });
  return path;
}

/** Creates a temporary directory that is deliberately not a git repository. */
export async function createTemporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "squad-plain-"));
}
