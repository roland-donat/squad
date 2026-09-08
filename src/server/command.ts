/**
 * Running a command line tool and carrying back what it said. Squad drives two
 * of them, git and `gh`, and a failure of either is something the developer has
 * to read: "the command failed" sends them to a terminal to find out what squad
 * already knew.
 *
 * What each caller does with a failure differs, which is why this hands back the
 * reason rather than an error of its own choosing: git failing a merge is a
 * refused request, `gh` failing to open a pull request is a delivery that did
 * not happen, and the two are answered in different places.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * A tool that ran and came back unhappy, with what it printed on the way out.
 *
 * Its message names the tool and what it was asked to do, never the arguments:
 * one of these travels into an alert a person reads on a phone, and squad hands
 * whole pull request descriptions and commit messages to these tools. The
 * arguments stay on the failure for whoever wants them.
 */
export class CommandFailure extends Error {
  constructor(
    readonly file: string,
    readonly args: readonly string[],
    /** What the tool said, from its error output when it wrote any. */
    readonly reason: string,
  ) {
    super(`${file} ${args.slice(0, 2).join(" ")} failed: ${reason}`);
    this.name = "CommandFailure";
  }
}

/** Runs a tool in a directory and hands back what it wrote on its output. */
export async function runCommand(
  cwd: string,
  file: string,
  args: readonly string[],
): Promise<string> {
  try {
    const { stdout } = await execute(file, [...args], { cwd });
    return stdout;
  } catch (cause) {
    throw new CommandFailure(file, args, reasonOf(cause));
  }
}

function reasonOf(cause: unknown): string {
  if (cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string") {
    const said = cause.stderr.trim();
    if (said !== "") return said;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
