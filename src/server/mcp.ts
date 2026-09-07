import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandler } from "express";
import { z } from "zod";
import { ticketKinds } from "../shared/api";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { Store } from "./store";

/**
 * Squad's MCP server: the only contract between the agents and squad (ADR 0002).
 * Everything an agent reports arrives as a schema-checked tool call, so a
 * malformed answer is rejected on the spot and the model is asked to try again,
 * instead of squad discovering the problem later. There is, and there must
 * remain, no prose parser anywhere in squad.
 */

/**
 * The name squad's tools are mounted under in a session. It decides how they are
 * spelled in the model's tool list, so it is declared once and read both by the
 * launcher that mounts them and by the briefing that names them.
 */
export const squadMcpServerName = "squad";

export const squadTools = {
  createTicket: "create_ticket",
  settleDecision: "settle_decision",
  readGraph: "read_graph",
} as const;

export type SquadTool = (typeof squadTools)[keyof typeof squadTools];

/** A squad tool as a session sees it, prefix and all. */
export function squadToolName(tool: SquadTool): string {
  return `mcp__${squadMcpServerName}__${tool}`;
}

const createTicketShape = {
  featureId: z.string().min(1).describe("The feature whose graph this ticket belongs to."),
  kind: z
    .enum(ticketKinds)
    .describe(
      "build for a vertical slice to construct, decision for a question to settle, which never runs, fix for a correction born of a red check.",
    ),
  title: z.string().trim().min(1).describe("One line, what the ticket delivers."),
  description: z.string().describe("What to build, in enough detail for a fresh session."),
  acceptanceCriteria: z
    .array(z.string().trim().min(1))
    .default([])
    .describe("Checkable statements; the test sheet is built from them."),
  blockedBy: z
    .array(z.string().min(1))
    .default([])
    .describe("Tickets of the same feature that must be merged before this one may start."),
  blocks: z
    .array(z.string().min(1))
    .default([])
    .describe("Tickets of the same feature this one must be merged before."),
};

const settleDecisionShape = {
  featureId: z.string().min(1).describe("The feature the decision ticket belongs to."),
  ticketId: z.string().min(1).describe("The decision ticket the developer has just settled."),
  conclusion: z
    .string()
    .trim()
    .min(1)
    .describe(
      "What was decided, in the developer's own terms, in enough detail for a fresh session to act on it without reading this thread.",
    ),
};

const readGraphShape = {
  featureId: z.string().min(1).describe("The feature whose graph to read."),
};

export interface McpDependencies {
  store: Store;
  bus: EventBus;
}

/**
 * One server per request, with no MCP session of its own: squad already holds
 * every piece of state a tool touches, so a session would only add a second
 * lifetime to keep in step with the agent's.
 */
export function buildMcpHandler(dependencies: McpDependencies): RequestHandler {
  return async (request, response) => {
    const server = buildMcpServer(dependencies);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
  };
}

function buildMcpServer({ store, bus }: McpDependencies): McpServer {
  const server = new McpServer({ name: "squad", version: "0.1.0" });

  server.registerTool(
    squadTools.createTicket,
    {
      title: "Create a ticket",
      description:
        "Adds one node to a feature graph, with its blocking edges. Blocking edges link two tickets of the same feature and must stay acyclic: an edge that would close a loop is refused, and the answer names the loop.",
      inputSchema: createTicketShape,
    },
    async (input) =>
      answer(() => {
        const ticket = store.createTicket(input);
        bus.publish({ type: "graph-changed", graph: store.featureGraph(input.featureId) });
        return ticket;
      }),
  );

  server.registerTool(
    squadTools.settleDecision,
    {
      title: "Settle a decision",
      description:
        "Records the conclusion of a decision ticket, closes it, and releases the tickets it was blocking. Only a ticket of kind decision can be settled, and only once. Call this as soon as the developer has decided in the thread: squad reads no prose, so a decision that is not written through this tool never reaches the graph.",
      inputSchema: settleDecisionShape,
    },
    async (input) =>
      answer(() => {
        const ticket = store.settleDecision(input);
        bus.publish({ type: "graph-changed", graph: store.featureGraph(ticket.featureId) });
        return ticket;
      }),
  );

  server.registerTool(
    squadTools.readGraph,
    {
      title: "Read the graph",
      description:
        "Returns every ticket of a feature with its computed state, and every blocking edge between them.",
      inputSchema: readGraphShape,
    },
    async ({ featureId }) => answer(() => store.featureGraph(featureId)),
  );

  return server;
}

/**
 * A refused call comes back as a tool error rather than a protocol failure: the
 * agent is meant to read the reason and correct its next call, which is the
 * whole point of putting the contract in the tools.
 */
function answer(produce: () => unknown): { content: Array<{ type: "text"; text: string }>; isError?: true } {
  try {
    return { content: [{ type: "text", text: JSON.stringify(produce(), null, 2) }] };
  } catch (failure) {
    if (failure instanceof SquadError) {
      return { content: [{ type: "text", text: failure.message }], isError: true };
    }
    throw failure;
  }
}
