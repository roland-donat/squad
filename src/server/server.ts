import { realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { apiRoutes, type Ticket } from "../shared/api";
import { createClaudeCodeLauncher } from "./agents/claude-code";
import type { AgentLauncher } from "./agents/launcher";
import { Alerts } from "./alerts";
import { Autonomy } from "./autonomy";
import { openDatabase } from "./db/open";
import { EventBus } from "./events";
import { buildApiRouter } from "./http";
import { Merges } from "./merges";
import { resolveDataDir, resolveRecordedSessionsDir } from "./paths";
import { Questions } from "./questions";
import { Resumptions } from "./resumptions";
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
  /**
   * Where claude-code keeps the conversations squad may resume. Defaults to its
   * real location; the seam suite hands in a directory it wrote itself, so a
   * test never reads the developer's own conversations.
   */
  recordedSessionsDir?: string;
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
  // be changed while squad runs, and the next alert must go to the new one. The
  // address is read late like the one above, and is none while squad is not yet
  // listening: what the previous run left is taken back before that.
  const alerts = new Alerts(store, (path) =>
    baseUrl === "" ? null : new URL(path, baseUrl).toString(),
  );
  const worktrees = new Worktrees(store, bus, dataDir);
  // Read late, like the address above: the sessions let go of what they were
  // waiting on when they end, and the questions are held by a module that has
  // to know the sessions to write on the right thread.
  const asked = { abandonFor: (sessionId: string) => questions.abandonFor(sessionId) };
  const stopped = { ticketStopped: (ticket: Ticket) => autonomy.ticketStopped(ticket) };
  const mainSessions = new MainSessions({ store, bus, launcher, questions: asked, mcpUrl });
  const subSessions = new SubSessions({
    store,
    bus,
    launcher,
    worktrees,
    alerts,
    questions: asked,
    autonomy: stopped,
    mcpUrl,
  });
  const autonomy = new Autonomy({ store, bus, alerts, subSessions });
  const merges = new Merges({ store, bus, alerts, worktrees, launcher, subSessions, autonomy, mcpUrl });
  const validations = new Validations({ alerts, merges, subSessions });
  const questions = new Questions({ store, bus, alerts, autonomy, mainSessions });
  const resumptions = new Resumptions({
    store,
    bus,
    mainSessions,
    recordedSessionsDir: options.recordedSessionsDir ?? resolveRecordedSessionsDir(),
  });
  // Before anything is served: a ticket the previous run left saying `running`
  // has no process behind it any more, and no client should ever be handed a
  // state squad already knows to be false. The questions of that run go the
  // same way: the session that asked them is gone, so an answer would reach
  // nobody.
  const stranded = subSessions.markInterrupted();
  questions.abandonInterrupted();

  const app = express();
  app.use(
    buildApiRouter({
      store,
      bus,
      mainSessions,
      subSessions,
      validations,
      merges,
      questions,
      autonomy,
      resumptions,
    }),
  );
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
  // Watched last: what the previous run left behind is squad's own to take
  // back, and a mode reading that churn would stop on a restart.
  const unwatch = autonomy.watch();

  return {
    url: baseUrl,
    port: address.port,
    dataDir,
    async close() {
      // Nothing more is driven, and nothing waits on an answer that will not
      // come: a session about to be stopped may be blocked on a question, and
      // the call that blocks it has to end before the process does.
      unwatch();
      questions.releaseAll();
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
