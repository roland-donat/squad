import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A real HTTP endpoint standing in for the chat squad posts its alerts to. Not
 * a double of anything inside squad: the request leaves the server, crosses the
 * loopback and is read here exactly as a chat webhook would read it.
 */
export interface WebhookReceiver {
  url: string;
  /** Resolves with the next payload received, or rejects on a timeout. */
  next(timeoutMs?: number): Promise<{ text?: string }>;
  /** Every payload received so far, which is what "nothing was sent" reads. */
  received(): Array<{ text?: string }>;
  close(): Promise<void>;
}

export async function startWebhookReceiver(): Promise<WebhookReceiver> {
  const payloads: Array<{ text?: string }> = [];
  const waiting: Array<(payload: { text?: string }) => void> = [];

  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const payload = JSON.parse(body === "" ? "{}" : body) as { text?: string };
      const resolve = waiting.shift();
      if (resolve) resolve(payload);
      else payloads.push(payload);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/alerts`,
    next(timeoutMs = 5_000) {
      const buffered = payloads.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise<{ text?: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiting.indexOf(handler);
          if (index !== -1) waiting.splice(index, 1);
          reject(new Error("timed out waiting for a webhook call"));
        }, timeoutMs);
        const handler = (payload: { text?: string }) => {
          clearTimeout(timer);
          resolve(payload);
        };
        waiting.push(handler);
      });
    },
    received: () => [...payloads],
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
