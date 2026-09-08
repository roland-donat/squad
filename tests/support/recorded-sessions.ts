import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A directory shaped like the one claude-code keeps its conversations in. Not a
 * double of anything inside squad: squad reads real files off a real disk, and
 * what is removed is the developer's own conversations, not the format.
 *
 * The shape is the one a real machine holds: one directory per project, one
 * `.jsonl` per session, and the transcripts of the agents a session spawned
 * under `<session>/subagents/`, which are not sessions and must not be offered.
 */
export interface RecordedSessionSpec {
  id?: string;
  /** Where the session ran, which is what says its repository. */
  cwd: string;
  branch?: string;
  title?: string;
  firstMessage?: string;
  /** When it was last written to, which is what orders the list. */
  recordedAt?: Date;
  /** True to write it as a sub-agent transcript rather than as a session. */
  subagent?: boolean;
}

export async function writeRecordedSessions(specs: RecordedSessionSpec[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "squad-sessions-"));
  for (const spec of specs) {
    const id = spec.id ?? randomUUID();
    const project = spec.cwd.replace(/[/.]/g, "-");
    const directory = spec.subagent
      ? join(root, project, id, "subagents")
      : join(root, project);
    await mkdir(directory, { recursive: true });
    const path = join(directory, spec.subagent ? `agent-${id}.jsonl` : `${id}.jsonl`);
    await writeFile(path, transcript(id, spec), "utf8");
    if (spec.recordedAt) await utimes(path, spec.recordedAt, spec.recordedAt);
  }
  return root;
}

/** The few lines squad reads: what a session is, never what was said in it. */
function transcript(id: string, spec: RecordedSessionSpec): string {
  const common = {
    cwd: spec.cwd,
    sessionId: id,
    gitBranch: spec.branch ?? "main",
    userType: "external",
    version: "2.0.0",
    timestamp: (spec.recordedAt ?? new Date()).toISOString(),
  };
  const lines: unknown[] = [];
  if (spec.title !== undefined) {
    lines.push({ type: "custom-title", customTitle: spec.title, sessionId: id });
  }
  lines.push({
    type: "user",
    isMeta: true,
    ...common,
    message: { role: "user", content: "<local-command-caveat>ignoré</local-command-caveat>" },
  });
  lines.push({
    type: "user",
    ...common,
    message: { role: "user", content: spec.firstMessage ?? "Une conversation." },
  });
  lines.push({
    type: "assistant",
    ...common,
    message: { role: "assistant", content: [{ type: "text", text: "Entendu." }] },
  });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
