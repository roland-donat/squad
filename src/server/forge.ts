import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The forge, reached through the `gh` command line rather than through its HTTP
 * API. Two reasons, and they are the same reason twice: `gh` already holds the
 * developer's credentials, and squad is a local tool that must not become a
 * place where a token is stored.
 *
 * Nothing here decides anything. Whether a pull request may merge on its own is
 * squad's call, made from what it recorded of the feature; this module only
 * carries that call to GitHub.
 */

export interface PullRequestRequest {
  /** The main checkout: `gh` reads the repository it is standing in. */
  repositoryRoot: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

/** Opens a pull request and hands back its address. */
export async function openPullRequest(request: PullRequestRequest): Promise<string> {
  const printed = await gh(request.repositoryRoot, [
    "pr",
    "create",
    "--base",
    request.base,
    "--head",
    request.head,
    "--title",
    request.title,
    "--body",
    request.body,
  ]);
  const url = printed
    .split("\n")
    .map((line) => line.trim())
    .findLast((line) => line.startsWith("http"));
  if (url === undefined) {
    throw new Error(`gh pr create said nothing that looks like a pull request address: ${printed}`);
  }
  return url;
}

/**
 * Asks the forge to merge the pull request as soon as its own checks allow it.
 *
 * Squad asks for this rather than merging outright, and rather than watching the
 * checks itself. "Merge if continuous integration is green" is exactly what
 * `--auto` means, and GitHub is the one that knows when that becomes true: a
 * squad that polled would be a squad whose answer is stale between two polls,
 * and one that merged straight away would merge a red branch.
 *
 * Two consequences worth knowing. A repository where auto-merge is not enabled
 * refuses this, and the pull request then simply stays open, which is what
 * happens to every pull request squad may not merge on its own. And a repository
 * with no required check at all merges at once: on such a repository the
 * integration check squad runs after every ticket merge is the only net, which
 * is why declaring the project's verification command matters.
 */
export async function requestAutoMerge(repositoryRoot: string, pullRequest: string): Promise<void> {
  await gh(repositoryRoot, ["pr", "merge", pullRequest, "--auto", "--merge"]);
}

/**
 * A `gh` call, with what it said carried on the failure: this is what reaches
 * the developer through an alert, and "the command failed" would send them to
 * the terminal to find out what squad already knew.
 */
async function gh(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gh", args, { cwd });
    return stdout;
  } catch (cause) {
    throw new Error(`gh ${args[0]} ${args[1]} failed: ${reasonOf(cause)}`);
  }
}

function reasonOf(cause: unknown): string {
  if (cause instanceof Error && "stderr" in cause && typeof cause.stderr === "string") {
    const said = cause.stderr.trim();
    if (said !== "") return said;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
