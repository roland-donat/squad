import { execFile } from "node:child_process";

/**
 * The integration check: the project's own typing and test pass, run on the
 * feature worktree after every ticket merge. It exists because two tickets that
 * were green apart can be red together, which no sub-session can see from its
 * own worktree.
 */

/** What a check said, and enough of what it printed to act on it. */
export interface IntegrationCheck {
  /** False when the project declares no command: nothing ran, so nothing is red. */
  ran: boolean;
  passed: boolean;
  /** What the command printed, tail first when it is long. */
  output: string;
}

/**
 * A verification is a whole test suite, so it is given room; but it is also the
 * thing every merge of the project queues behind, so it cannot be given
 * forever. A command still running after this has stopped being a check and
 * become a reason nothing else can merge, and it is read as red.
 */
const verificationTimeoutMs = 10 * 60 * 1000;

/** How much of the output is kept: enough to act on, not a whole test log. */
const keptOutputCharacters = 8_000;

/**
 * Runs the project's verification in a worktree. The command is a line the
 * developer wrote, so it goes to a shell as written: `pnpm verify`, or two
 * commands joined by `&&`, mean what they mean in a terminal.
 */
export function runVerification(
  command: string | null,
  worktreePath: string,
): Promise<IntegrationCheck> {
  if (command === null) return Promise.resolve({ ran: false, passed: true, output: "" });
  return new Promise((resolve) => {
    execFile(
      "sh",
      ["-c", command],
      { cwd: worktreePath, timeout: verificationTimeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (failure, stdout, stderr) => {
        const output = tail(`${stdout}${stderr}`.trim());
        if (failure === null) {
          resolve({ ran: true, passed: true, output });
          return;
        }
        // A command that could not be started at all is red like one that
        // failed: either way, nothing checked this feature branch.
        resolve({
          ran: true,
          passed: false,
          output: output === "" ? failure.message : `${output}\n${failure.message}`,
        });
      },
    );
  });
}

/** The end of what a command printed, which is where a failure says why. */
function tail(output: string): string {
  return output.length <= keptOutputCharacters
    ? output
    : `[...]\n${output.slice(-keptOutputCharacters)}`;
}
