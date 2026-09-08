import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecordedSession } from "../shared/api";

/**
 * The conversations claude-code has already recorded, which is where a feature
 * can start from instead of an empty thread. The design work happens at the
 * terminal by design (it is out of the first milestone), so the one thing
 * missing is the door between that work and squad: a session held here carries
 * the grilling, the spec and every arbitration that produced them.
 *
 * Everything here is best effort. This is another program's private storage,
 * undocumented and free to change shape: a directory that is not there, a file
 * that cannot be read or a line that does not parse yields fewer sessions
 * rather than an error, and squad opens features exactly as it did before.
 *
 * Squad reads what identifies a session and nothing else: where it ran, on which
 * branch, what it was called, what was first asked of it, when, and how big it
 * is. What was said in it is never read, and never becomes squad's state: the
 * session itself is asked about that, once it is resumed.
 */

/** How much of a transcript is read to identify it: its head, never its body. */
const headBytes = 16_384;

/** How many lines of that head are looked at before giving up on a field. */
const headLines = 40;

/**
 * The sessions of one machine, newest first. Only `<project>/<session>.jsonl` is
 * a session: a transcript under `<session>/subagents/` belongs to an agent a
 * session spawned, and resuming one as a main session would resume something
 * that never drove anything. On a real machine the second kind outnumbers the
 * first by eight to one.
 */
export async function listRecordedSessions(root: string): Promise<RecordedSession[]> {
  const files = await recordedFiles(root);
  const read = await Promise.all(files.map((file) => describe(file.path, file.recordedAt)));
  return read
    .filter((session): session is RecordedSession => session !== null)
    .sort((one, other) => other.recordedAt.localeCompare(one.recordedAt));
}

/**
 * What a search matches: what identifies a session to the person looking for it.
 * Not what was said in it, which would ask for an index of gigabytes; this is
 * the repository, the branch, the title and the first thing asked.
 */
export function matchesSearch(session: RecordedSession, search: string): boolean {
  const terms = search.trim().toLowerCase().split(/\s+/).filter((term) => term !== "");
  if (terms.length === 0) return true;
  const haystack = [session.cwd, session.branch, session.title, session.firstMessage]
    .filter((part): part is string => part !== null)
    .join(" ")
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

async function recordedFiles(
  root: string,
): Promise<Array<{ path: string; recordedAt: string }>> {
  let projects: string[];
  try {
    projects = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No directory at all is the ordinary answer on a machine where claude-code
    // has never run, and it is not a failure: there is simply nothing to resume.
    return [];
  }

  const found: Array<{ path: string; recordedAt: string }> = [];
  for (const project of projects) {
    let entries;
    try {
      entries = await readdir(join(root, project), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(root, project, entry.name);
      try {
        found.push({ path, recordedAt: (await stat(path)).mtime.toISOString() });
      } catch {
        continue;
      }
    }
  }
  return found;
}

/**
 * One session, read from the head of its transcript. The whole file is never
 * opened: the transcripts of a working machine run to tens of megabytes each,
 * and everything named here is written in the first few lines.
 */
async function describe(path: string, recordedAt: string): Promise<RecordedSession | null> {
  const head = await readHead(path);
  if (head === null) return null;
  const bytes = head.bytes;
  let id: string | null = null;
  let cwd: string | null = null;
  let branch: string | null = null;
  let title: string | null = null;
  let firstMessage: string | null = null;

  for (const line of head.text.split("\n").slice(0, headLines)) {
    const entry = parse(line);
    if (entry === null) continue;
    id ??= text(entry["sessionId"]);
    cwd ??= text(entry["cwd"]);
    branch ??= text(entry["gitBranch"]);
    if (entry["type"] === "custom-title") title ??= text(entry["customTitle"]);
    if (entry["type"] === "user" && entry["isMeta"] !== true) {
      firstMessage ??= firstWords(entry["message"]);
    }
  }
  // Without an identifier there is nothing to resume, and without a working
  // directory nothing to resume it in: such a file is not offered at all.
  if (id === null || cwd === null) return null;
  return { id, cwd, branch, title, firstMessage, recordedAt, bytes };
}

async function readHead(path: string): Promise<{ text: string; bytes: number } | null> {
  try {
    const [content, entry] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    return { text: content.slice(0, headBytes), bytes: entry.size };
  } catch {
    return null;
  }
}

function parse(line: string): Record<string, unknown> | null {
  if (line.trim() === "") return null;
  try {
    const entry: unknown = JSON.parse(line);
    return typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : null;
  } catch {
    // A head cut mid-line, or a shape squad does not know: the next line may
    // still say what this one could not.
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The opening of what was first asked, as a line to recognise a session by. The
 * message may be a string or the content blocks of one; anything else is left
 * out rather than rendered as an object nobody can read.
 */
function firstWords(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const content = (message as { content?: unknown }).content;
  const said =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter(
              (block): block is { type: "text"; text: string } =>
                typeof block === "object" &&
                block !== null &&
                (block as { type?: unknown }).type === "text" &&
                typeof (block as { text?: unknown }).text === "string",
            )
            .map((block) => block.text)
            .join(" ")
        : null;
  if (said === null) return null;
  const plain = said.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return plain === "" ? null : plain.slice(0, 200);
}
