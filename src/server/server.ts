import { realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { openDatabase } from "./db/open";
import { EventBus } from "./events";
import { buildApiRouter } from "./http";
import { resolveDataDir } from "./paths";
import { Store } from "./store";
import { mountUi, type UiMode } from "./ui";

export interface SquadServerOptions {
  /** Defaults to the user's data directory; the seam tests pass a temporary one. */
  dataDir?: string;
  /** 0 asks the operating system for a free port, which the tests rely on. */
  port?: number;
  ui?: UiMode;
}

/** Squad is a single-user tool on a single machine: it never leaves the loopback. */
const host = "127.0.0.1";
export const defaultPort = 7300;

export interface RunningSquadServer {
  url: string;
  port: number;
  dataDir: string;
  close(): Promise<void>;
}

export async function startSquadServer(
  options: SquadServerOptions = {},
): Promise<RunningSquadServer> {
  const requestedDataDir = options.dataDir ?? resolveDataDir();
  const port = options.port ?? defaultPort;

  const { db, close: closeDatabase } = await openDatabase(requestedDataDir);
  // Resolved only once the directory exists, and through its symlinks, since it
  // is compared against repository roots git reports the same way.
  const dataDir = await realpath(requestedDataDir);
  const store = new Store(db, dataDir);
  const bus = new EventBus();

  const app = express();
  app.use(buildApiRouter({ store, bus }));
  const ui = await mountUi(app, options.ui ?? "auto");

  const server = createServer(app);
  await listen(server, port, host);
  const address = server.address() as AddressInfo;

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    dataDir,
    async close() {
      // Event streams are long lived by design: without this, closing the
      // server would wait for every open browser tab to go away.
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await ui.close();
      closeDatabase();
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}
