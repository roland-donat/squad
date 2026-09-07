import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiRoutes, type Feature, type Project, type SquadEvent } from "../../src/shared/api";
import type { AgentLauncher } from "../../src/server/agents/launcher";
import { startSquadServer } from "../../src/server/server";
import { createTemporaryRepository } from "./git";

/**
 * Drives squad exactly like the browser does: over HTTP and the event stream.
 * No test reaches into a module from the inside, so a test only breaks when
 * observable behaviour changes.
 */
export interface TestSquad {
  url: string;
  dataDir: string;
  /** Stops the server and starts a new one on the same data directory. */
  restart(): Promise<void>;
  dispose(): Promise<void>;
  request(method: string, path: string, body?: unknown): Promise<Response>;
  openEventStream(): Promise<EventStream>;
}

export interface TestSquadOptions {
  /** Where the database goes; a temporary directory of its own by default. */
  dataDir?: string;
  /** The scripted double, for a scenario that has an agent do the work. */
  launcher?: AgentLauncher;
}

export async function startTestSquad(options: TestSquadOptions = {}): Promise<TestSquad> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "squad-data-")));
  const start = () =>
    startSquadServer({
      dataDir,
      port: 0,
      ui: "none",
      ...(options.launcher === undefined ? {} : { launcher: options.launcher }),
    });
  let server = await start();
  const streams: EventStream[] = [];
  // Through the API, like everything else a test does. Squad raises a desktop
  // notification whenever progress stops, and the seam suite runs on a
  // developer's desktop: silencing that channel is a setting, not a hatch, and
  // a scenario that wants to watch an alert reads the webhook instead.
  const silenced = await fetch(new URL(apiRoutes.settings, server.url), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ desktopNotifications: false }),
  });
  // Checked rather than fired and forgotten: a refusal here would arm the
  // desktop channel again, and the suite would say nothing about it.
  if (!silenced.ok) throw new Error(`could not silence desktop notifications: ${silenced.status}`);

  const squad: TestSquad = {
    get url() {
      return server.url;
    },
    dataDir,
    async restart() {
      await server.close();
      server = await start();
    },
    async dispose() {
      for (const stream of streams) stream.close();
      await server.close();
      if (options.dataDir === undefined) await rm(dataDir, { recursive: true, force: true });
    },
    async request(method, path, body) {
      return fetch(new URL(path, server.url), {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    async openEventStream() {
      const stream = await openEventStream(new URL("/api/events", server.url));
      streams.push(stream);
      return stream;
    },
  };
  return squad;
}

export interface EventStream {
  /** Resolves with the next event, or rejects once the timeout elapses. */
  next(timeoutMs?: number): Promise<SquadEvent>;
  close(): void;
}

async function openEventStream(url: URL): Promise<EventStream> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.body) throw new Error("event stream has no body");

  const pending: SquadEvent[] = [];
  const waiting: Array<(event: SquadEvent) => void> = [];
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();

  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += value;
        let separator = buffer.indexOf("\n\n");
        while (separator !== -1) {
          const frame = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const payload = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trim())
            .join("\n");
          if (payload) {
            const event = JSON.parse(payload) as SquadEvent;
            const resolve = waiting.shift();
            if (resolve) resolve(event);
            else pending.push(event);
          }
          separator = buffer.indexOf("\n\n");
        }
      }
    } catch {
      // The stream was aborted by close(); nothing to report.
    }
  })();

  return {
    next(timeoutMs = 5_000) {
      const buffered = pending.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise<SquadEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.indexOf(handler);
          if (index !== -1) waiting.splice(index, 1);
          reject(new Error("timed out waiting for a squad event"));
        }, timeoutMs);
        const handler = (event: SquadEvent) => {
          clearTimeout(timer);
          resolve(event);
        };
        waiting.push(handler);
      });
    },
    close() {
      controller.abort();
    },
  };
}

/**
 * A registered project and an open feature on it, which every scenario needs
 * before an agent has anywhere to write. Goes through the API like the rest.
 */
export async function openTestFeature(
  squad: TestSquad,
  title: string,
): Promise<{ project: Project; feature: Feature; repository: string }> {
  const repository = await createTemporaryRepository();
  const registered = await squad.request("POST", apiRoutes.projects, { path: repository });
  const { project } = (await registered.json()) as { project: Project };
  const opened = await squad.request("POST", apiRoutes.features, {
    projectId: project.id,
    title,
  });
  const { feature } = (await opened.json()) as { feature: Feature };
  // The path git reports, symlinks resolved: on macOS the temporary directory
  // is one, and a test comparing worktree paths would compare two spellings of
  // the same place.
  return { project, feature, repository: project.path };
}

/** Waits for the next event of a given type, dropping whatever comes before it. */
export async function waitForEvent<T extends SquadEvent["type"]>(
  stream: EventStream,
  type: T,
): Promise<Extract<SquadEvent, { type: T }>> {
  for (;;) {
    const event = await stream.next();
    if (event.type === type) return event as Extract<SquadEvent, { type: T }>;
  }
}
