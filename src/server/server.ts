import { realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { apiRoutes } from "../shared/api";
import { createClaudeCodeLauncher } from "./agents/claude-code";
import type { AgentLauncher } from "./agents/launcher";
import { Alerts } from "./alerts";
import { openDatabase } from "./db/open";
import { EventBus } from "./events";
import { buildApiRouter } from "./http";
import { Merges } from "./merges";
import { resolveDataDir } from "./paths";
import { MainSessions } from "./sessions";
import { Store } from "./store";
import { SubSessions } from "./sub-sessions";
import { mountUi, type UiMode } from "./ui";
import { Validations } from "./validations";
import { Worktrees } from "./worktrees";

export interface SquadServerOptions {
  /** Defaults to the user's data directory; the seam tests pass a temporary one. */
  dataDir?: string;
  /** 0 asks the operating system for a free port, which the tests rely on. */
  port?: number;
  ui?: UiMode;
  /**
   * How claude-code sessions are opened. Defaults to the real launcher; the seam
   * tests hand in a scripted double instead, which is the only place squad's
   * non-determinism is removed.
   */
  launcher?: AgentLauncher;
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
  // Squad only learns its own address once it is listening, and the sessions it
  // opens need it to point their agents back at its MCP endpoint. Read late, on
  // the first session opened, hence long after the assignment below.
  let baseUrl = "";
  const mcpUrl = () => new URL(apiRoutes.mcp, baseUrl).toString();
  const launcher = options.launcher ?? createClaudeCodeLauncher();
  // Reads the settings at every alert rather than holding them: the webhook can
  // be changed while squad runs, and the next alert must go to the new one.
  const alerts = new Alerts(store);
  const worktrees = new Worktrees(store, bus, dataDir);
  const mainSessions = new MainSessions({ store, bus, launcher, mcpUrl });
  const subSessions = new SubSessions({ store, bus, launcher, worktrees, alerts, mcpUrl });
  const merges = new Merges({ store, bus, alerts, worktrees, launcher, subSessions, mcpUrl });
  const validations = new Validations({ alerts, merges, subSessions });
  // Before anything is served: a ticket the previous run left saying `running`
  // has no process behind it any more, and no client should ever be handed a
  // state squad already knows to be false.
  const stranded = subSessions.markInterrupted();

  const app = express();
  app.use(buildApiRouter({ store, bus, mainSessions, subSessions, validations, merges }));
  const ui = await mountUi(app, options.ui ?? "auto");

  const server = createServer(app);
  await listen(server, port, host);
  const address = server.address() as AddressInfo;
  baseUrl = `http://${host}:${address.port}`;
  // Once squad has an address to point them at: the sub-sessions taken back
  // here reach squad's tools over this very port, and so does the resolution
  // session a merge taken back may have to open.
  subSessions.takeBack(stranded);
  merges.resumeInterrupted();

  return {
    url: baseUrl,
    port: address.port,
    dataDir,
    async close() {
      // The merges last: one of them may be waiting on a sub-session it closed,
      // and the database has to outlive the last line either of them writes.
      await Promise.all([mainSessions.stopAll(), subSessions.stopAll()]);
      await merges.stopAll();
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
