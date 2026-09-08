import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A real `gh` on the path, standing in for the GitHub command line. Not a double
 * of anything inside squad: squad spawns a process, hands it arguments and reads
 * what it prints, exactly as it would with the real one. What is removed is the
 * network and an account, not the contract.
 *
 * It is put first on `PATH`, which is how a command is chosen on this machine.
 * The seam suite runs each file in a worker of its own, and the tests of a file
 * run one after another, so the change is undone by `restore` before anything
 * else could see it.
 */
export interface GhStub {
  /** Every call that has finished, as the arguments squad passed. */
  calls(): Promise<string[][]>;
  /** The calls of one `gh` subcommand, "pr create" and the like. */
  callsTo(...subcommand: string[]): Promise<string[][]>;
  /**
   * Whether two calls were ever in flight at once. Each call holds for a moment
   * before answering, so two that are not serialised overlap and are seen here.
   */
  overlapped(): Promise<boolean>;
  /** Makes every call from now on fail, as a forge refusing would. */
  refuse(reason: string): Promise<void>;
  restore(): void;
}

/** Long enough that anything running in parallel is seen overlapping it. */
const holdMs = 150;

export async function installGhStub(): Promise<GhStub> {
  const directory = await mkdtemp(join(tmpdir(), "squad-gh-"));
  const log = join(directory, "calls.jsonl");
  const refusal = join(directory, "refusal");
  await writeFile(log, "");

  const script = join(directory, "gh");
  await writeFile(script, stubSource(log, refusal), "utf8");
  await chmod(script, 0o755);

  const previousPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${directory}:${previousPath}`;

  const entries = async (): Promise<StubEntry[]> => {
    const written = await readFile(log, "utf8");
    return written
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as StubEntry);
  };
  const calls = async () =>
    (await entries()).filter((entry) => entry.phase === "end").map((entry) => entry.args);

  return {
    calls,
    async callsTo(...subcommand) {
      return (await calls()).filter((args) =>
        subcommand.every((word, index) => args[index] === word),
      );
    },
    async overlapped() {
      let inFlight = 0;
      for (const entry of await entries()) {
        inFlight += entry.phase === "start" ? 1 : -1;
        if (inFlight > 1) return true;
      }
      return false;
    },
    async refuse(reason) {
      await writeFile(refusal, reason);
    },
    restore() {
      process.env["PATH"] = previousPath;
    },
  };
}

interface StubEntry {
  phase: "start" | "end";
  args: string[];
}

/**
 * Written as CommonJS on purpose: the file has no extension and no package.json
 * beside it, so node reads it as a script rather than as a module.
 */
function stubSource(log: string, refusal: string): string {
  return `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const write = (phase) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase, args }) + "\\n");
write("start");
// Held for a moment, so two calls that were not serialised are seen to overlap.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
write("end");
if (existsSync(${JSON.stringify(refusal)})) {
  process.stderr.write(readFileSync(${JSON.stringify(refusal)}, "utf8"));
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "create") {
  // One address per pull request, told apart by how many were opened before it.
  const opened = readFileSync(${JSON.stringify(log)}, "utf8")
    .split("\\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.phase === "end" && entry.args[0] === "pr" && entry.args[1] === "create");
  process.stdout.write("https://forge.test/squad/pull/" + opened.length + "\\n");
}
`;
}
