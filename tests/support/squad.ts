import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SquadEvent } from "../../src/shared/api";
import { startSquadServer } from "../../src/server/server";

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
}

export async function startTestSquad(options: TestSquadOptions = {}): Promise<TestSquad> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "squad-data-")));
  let server = await startSquadServer({ dataDir, port: 0, ui: "none" });
  const streams: EventStream[] = [];

  const squad: TestSquad = {
    get url() {
      return server.url;
    },
    dataDir,
    async restart() {
      await server.close();
      server = await startSquadServer({ dataDir, port: 0, ui: "none" });
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
