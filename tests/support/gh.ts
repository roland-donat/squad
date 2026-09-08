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
  /**
   * The finished calls of one `gh` subcommand, as the arguments squad passed.
   * A subcommand is its first two words, "pr create" and the like, which is how
   * `gh` itself is spelled and how the stub files a refusal.
   */
  callsTo(...subcommand: string[]): Promise<string[][]>;
  /**
   * Whether two calls were ever in flight at once. Each call holds for a moment
   * before answering, so two that are not serialised overlap and are seen here.
   */
  overlapped(): Promise<boolean>;
  /**
   * Makes one subcommand fail from now on, as a forge refusing would. Named
   * rather than blanket: a test that wants a refused merge still needs the
   * pull request that is being refused.
   */
  refuse(subcommand: string, reason: string): Promise<void>;
  /** Where a refusal of a subcommand is filed, shared with the stub itself. */
  restore(): void;
}

/** Long enough that anything running in parallel is seen overlapping it. */
const holdMs = 150;

export async function installGhStub(): Promise<GhStub> {
  const directory = await mkdtemp(join(tmpdir(), "squad-gh-"));
  const log = join(directory, "calls.jsonl");
  await writeFile(log, "");

  const script = join(directory, "gh");
  await writeFile(script, stubSource(log, directory), "utf8");
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
    async refuse(subcommand, reason) {
      await writeFile(refusalFile(directory, subcommand.split(/\s+/)), reason);
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
 * Where refusals are filed: this prefix followed by the two words of the
 * subcommand. Spelled once, here, and read from here by both sides: two
 * spellings of the same name would let `refuse` write a file the stub never
 * looks for, and the refusal would simply not happen.
 */
function refusalPrefix(directory: string): string {
  return join(directory, "refusal-");
}

function refusalFile(directory: string, subcommand: readonly string[]): string {
  return refusalPrefix(directory) + subcommand.slice(0, 2).join("-");
}

/**
 * Written as CommonJS on purpose: the file has no extension and no package.json
 * beside it, so node reads it as a script rather than as a module.
 */
function stubSource(log: string, directory: string): string {
  // The prefix, not the whole name: the stub appends the two words of the
  // subcommand it was actually called with.
  const prefix = refusalPrefix(directory);
  return `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
const write = (phase) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ phase, args }) + "\\n");
write("start");
// Held for a moment, so two calls that were not serialised are seen to overlap.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
write("end");
const refusal = ${JSON.stringify(prefix)} + args.slice(0, 2).join("-");
if (existsSync(refusal)) {
  process.stderr.write(readFileSync(refusal, "utf8"));
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
