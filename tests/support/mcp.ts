import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { apiRoutes } from "../../src/shared/api";

/**
 * An MCP client on squad's endpoint, connected exactly as a claude-code session
 * would be. Nothing here reaches inside the server: the tools are called over
 * the wire, so a test sees the same contract an agent sees.
 */
export interface McpConnection {
  /** Returns the parsed JSON a tool answered with, and fails on a tool error. */
  call(tool: string, input: unknown): Promise<unknown>;
  /** Returns the tool's raw outcome, so a refusal can be inspected. */
  attempt(tool: string, input: unknown): Promise<ToolOutcome>;
  listTools(): Promise<string[]>;
  /** The schema of one tool as an agent receives it, fields and bounds and all. */
  toolSchema(tool: string): Promise<ToolSchema>;
  close(): Promise<void>;
}

/** A published input schema, reduced to what a test has anything to say about. */
export interface ToolSchema {
  fields: string[];
  /** The description of one field, which is where a bound is spelled out. */
  describe(field: string): string;
}

export interface ToolOutcome {
  refused: boolean;
  text: string;
}

/** The answer a tool gave, or a failure naming the refusal it gave instead. */
export function readToolAnswer(tool: string, outcome: ToolOutcome): unknown {
  if (outcome.refused) throw new Error(`${tool} refused the call: ${outcome.text}`);
  return JSON.parse(outcome.text) as unknown;
}

export async function connectToSquadTools(baseUrl: string): Promise<McpConnection> {
  const client = new Client({ name: "squad-seam-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(apiRoutes.mcp, baseUrl)));

  async function attempt(tool: string, input: unknown): Promise<ToolOutcome> {
    const result = await client.callTool({ name: tool, arguments: input as Record<string, unknown> });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return { refused: result.isError === true, text };
  }

  return {
    attempt,
    async call(tool, input) {
      return readToolAnswer(tool, await attempt(tool, input));
    },
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => tool.name).sort();
    },
    async toolSchema(name) {
      const { tools } = await client.listTools();
      const tool = tools.find((each) => each.name === name);
      if (!tool) throw new Error(`no tool named ${name}`);
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      return {
        fields: Object.keys(properties).sort(),
        describe: (field) => JSON.stringify(properties[field] ?? null),
      };
    },
    async close() {
      await client.close();
    },
  };
}

/** Anything that can call a squad tool: an MCP connection, or a scripted agent. */
export interface ToolCaller {
  call(tool: string, input: unknown): Promise<unknown>;
}

/**
 * The decor the tests work in. One example for every scenario, because what is
 * being exercised is that a decor exists and is refused when absent, never what
 * it says.
 */
export const testRunningExample =
  "Une librairie : Camille tient la caisse, Dominique range les rayons, et un exemplaire de « Bel-Ami » passe de l'un à l'autre.";

/**
 * Writes a ticket the way an agent does, over the wire, filling what a scenario
 * about something else has no opinion on: the running example the feature needs
 * before its first ticket, and a plausible summary.
 *
 * A helper rather than four more lines at each of the forty call sites: what
 * each test is about would be buried under boilerplate it never reads. The
 * tests of the summary itself pass their own, and the tests of the bounds and
 * of the refusals call `create_ticket` raw through `attempt`, which is the only
 * way to see what it answers.
 */
export async function writeTicket(
  caller: ToolCaller,
  input: Record<string, unknown> & { featureId: string },
): Promise<unknown> {
  const kind = typeof input.kind === "string" ? input.kind : "build";
  // A fix ticket carries no example, so it needs no decor. Every other kind
  // does, and the tool refuses without one: the tests go through that rule
  // rather than around it. Writing it again is free, and announces nothing.
  if (kind !== "fix") {
    await caller.call("set_running_example", {
      featureId: input.featureId,
      runningExample: testRunningExample,
    });
  }
  return caller.call("create_ticket", { ...input, kind, summary: input.summary ?? aSummary(kind) });
}

/**
 * A summary a scenario about something else has no opinion on. Given out here
 * rather than written at each call site, and passed explicitly by the tests
 * that call `create_ticket` raw to see a refusal: without it those calls are
 * refused for a missing summary and never reach the refusal they are about.
 */
export function aSummary(kind = "build"): Record<string, string> {
  const shared = {
    context: "La librairie enregistre ses ventes à la main, sur un cahier.",
    problem: "Rien ne dit ce qui reste en rayon quand deux ventes tombent en même temps.",
  };
  if (kind === "fix") return shared;
  return {
    ...shared,
    example:
      "Camille vend le dernier « Bel-Ami » pendant que Dominique en range un autre : le cahier en compte un, le rayon en a deux.",
  };
}
