import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { Question, Ticket } from "../shared/api";
import { ticketKinds } from "../shared/api";
import type { AskInput } from "./questions";
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
  reportStep: "report_step",
  askQuestion: "ask_question",
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
  bornOf: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The ticket you are building, when your work uncovered this one. It is what squad counts the depth of a cascade with: leave it out only for a ticket nobody's work uncovered.",
    ),
};

const askQuestionShape = {
  featureId: z.string().min(1).describe("The feature you are working on."),
  ticketId: z
    .string()
    .min(1)
    .optional()
    .describe("The ticket you are building. Leave it out from the main session."),
  question: z
    .string()
    .trim()
    .min(1)
    .describe("What you are asking, in one or two sentences, readable by someone who did not watch."),
  options: z
    .array(z.string().trim().min(1))
    .min(2)
    .describe("The answers you are offering, at least two, each one a line the developer can pick."),
  recommendation: z
    .string()
    .trim()
    .min(1)
    .describe("The option you recommend, written exactly as one of the options above."),
  scopeChanging: z
    .boolean()
    .describe(
      "True when the answer changes what is built: the perimeter, the contract, what the ticket delivers. False when it changes only how it is built. Declare it honestly: it is what decides whether squad may answer for the developer while they are away.",
    ),
};

const reportStepShape = {
  featureId: z.string().min(1).describe("The feature the ticket belongs to."),
  ticketId: z.string().min(1).describe("The ticket whose step you are ending."),
  summary: z
    .string()
    .trim()
    .min(1)
    .describe("What you built and how, in a few lines, for someone who did not watch."),
  coverage: z
    .array(
      z.object({
        criterionId: z
          .string()
          .min(1)
          .describe("The id of the acceptance criterion, as handed to you with the ticket."),
        covered: z
          .boolean()
          .describe(
            "True when an automatic test you wrote or ran actually checks this criterion. False when only a human can tell.",
          ),
      }),
    )
    .describe(
      "One entry per acceptance criterion of the ticket, exactly once each and none other. Every criterion you declare uncovered becomes a point the developer checks by hand.",
    ),
  suggestions: z
    .array(z.string().trim().min(1))
    .default([])
    .describe(
      "Points you suggest checking by hand beyond the criteria: what the ticket did not foresee and you would look at yourself.",
    ),
  recommendation: z
    .string()
    .trim()
    .min(1)
    .describe("What you recommend doing next, in one or two sentences."),
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
  /**
   * Where a question goes and where its answer comes back from. Declared by
   * what is needed of it: the call below waits on this promise, and nothing
   * else in squad waits on anything.
   */
  questions: { ask(input: AskInput): Promise<Question> };
  /**
   * What go-as-recommended does with a ticket an agent asked for. Declared the
   * same way: a cascade deep enough to stop the mode is the mode's business,
   * not the tool's.
   */
  autonomy: { ticketCreated(ticket: Ticket): void };
  /**
   * What a reported step leads to: an alert on a sheet somebody has to read, a
   * merge on a sheet with nothing on it. Declared by what is needed of it
   * rather than by who provides it.
   */
  validations: { afterReport(ticket: Ticket): void };
  /**
   * What opens the sub-sessions the caps allow. Declared by what is needed of
   * it rather than by who provides it: a settled decision releases the tickets
   * it blocked, and one of them may be a launch already waiting for it.
   */
  subSessions: { schedule(): void };
  /**
   * Likewise: a settled decision may be the last node of its graph to come to
   * rest, and a feature that has come back whole is one to send off.
   */
  merges: { deliver(featureId: string): void };
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

function buildMcpServer({
  store,
  bus,
  questions,
  autonomy,
  validations,
  subSessions,
  merges,
}: McpDependencies): McpServer {
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
        // Before the graph is announced, and not after: announcing it is what
        // makes the mode look at the frontier again, and a cascade that has
        // gone as deep as the developer allows must stop the mode before it
        // launches the very ticket that reached the depth. Nothing is undone by
        // it: the ticket is written either way.
        autonomy.ticketCreated(ticket);
        bus.publish({ type: "graph-changed", graph: store.featureGraph(input.featureId) });
        return ticket;
      }),
  );

  server.registerTool(
    squadTools.askQuestion,
    {
      title: "Ask the developer",
      description:
        "Asks the developer something you may not decide alone, with the options you see and the one you recommend. The call does not return until it is answered, and the answer comes back as its result: ask, then act on what comes back. Say honestly whether the answer changes what is built or only how, since that is what decides whether squad may answer with your recommendation while the developer is away. Ask about what is yours to build: a question about the perimeter of another ticket belongs to a decision ticket, not here.",
      inputSchema: askQuestionShape,
    },
    async (input, extra) =>
      answer(async () => {
        const question = await keepAlive(extra, () =>
          questions.ask({
            featureId: input.featureId,
            ticketId: input.ticketId ?? null,
            prompt: input.question,
            options: input.options,
            recommendation: input.recommendation,
            scopeChanging: input.scopeChanging,
          }),
        );
        if (question.state !== "answered") {
          throw new SquadError(
            "question_not_pending",
            409,
            "squad stopped while this question was waiting: it was not answered, and nothing was decided on it",
          );
        }
        return question;
      }),
  );

  server.registerTool(
    squadTools.reportStep,
    {
      title: "Report the end of a step",
      description:
        "Ends the step of a ticket: what you built, whether an automatic test covers each acceptance criterion, what you suggest checking by hand, and what you recommend doing next. The criteria you declare uncovered, plus your suggestions, become the test sheet the developer goes through. Reporting puts the ticket in awaiting-validation; stay available afterwards, since what a point fails on comes back to you. A step you do not report through this tool is a step squad has to ask you about again: it never concludes a ticket is done because a session stopped.",
      inputSchema: reportStepShape,
    },
    async (input) =>
      answer(() => {
        const ticket = store.recordStepReport(input);
        bus.publish({ type: "graph-changed", graph: store.featureGraph(ticket.featureId) });
        // An empty sheet stops nothing: it says the criteria are all covered and
        // there is nothing for a human to look at, so nobody is woken for it and
        // the branch goes on to merge. What decides that lives in one place.
        validations.afterReport(ticket);
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
        // A blocker that clears is a launch that may now be admissible: a ticket
        // whose launch was asked for before a decision was posted in front of it
        // has been waiting on this answer, not on a place.
        subSessions.schedule();
        // And a decision settled after everything else has merged is the last
        // node of its graph coming to rest: nothing else would ever look again.
        merges.deliver(ticket.featureId);
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
async function answer(
  produce: () => unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await produce(), null, 2) }] };
  } catch (failure) {
    if (failure instanceof SquadError) {
      return { content: [{ type: "text", text: failure.message }], isError: true };
    }
    throw failure;
  }
}

/**
 * What a call that may wait for hours needs from its caller: a token to report
 * progress under, and a way to send it. Declared structurally, so this file
 * says what it uses of the transport rather than borrowing its whole shape.
 */
interface CallContext {
  _meta?: { progressToken?: string | number } | undefined;
  sendNotification: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number };
  }) => Promise<void>;
}

/**
 * How long squad waits between two signs of life on a call that is blocked. The
 * protocol says a client should push its timeout back on each of them, and a
 * question waits for a person: without this, the only calls that could be
 * answered are the ones answered within a client's own patience.
 *
 * A client that asked for no progress token gets none, and then the wait is
 * bounded by whatever that client decided. Nothing here can fix that from this
 * side, and a call cut short comes back as a question nobody answered rather
 * than as an answer squad invented.
 */
const heartbeatMs = 25_000;

async function keepAlive<T>(context: CallContext, work: () => Promise<T>): Promise<T> {
  const progressToken = context._meta?.progressToken;
  if (progressToken === undefined) return work();
  let progress = 0;
  const beat = setInterval(() => {
    progress += 1;
    void context
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress } })
      // Best effort, like every other signal squad sends about itself: a
      // notification that cannot be delivered must not fail the call it is
      // keeping alive.
      .catch(() => {});
  }, heartbeatMs);
  // The process must be able to end while a question waits: what holds squad up
  // is the call, not this timer.
  beat.unref();
  try {
    return await work();
  } finally {
    clearInterval(beat);
  }
}
