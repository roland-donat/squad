import { SquadError } from "../errors";
import type { AgentLauncher } from "./launcher";

/**
 * The launcher squad falls back on until the real one is wired in. It refuses
 * loudly rather than pretending a session started: a ticket silently never
 * running is the failure that costs a night.
 */
export const unavailableLauncher: AgentLauncher = {
  async open() {
    throw new SquadError(
      "agent_launcher_unavailable",
      501,
      "no agent launcher is wired in: squad cannot open a claude-code session yet",
    );
  },
};
