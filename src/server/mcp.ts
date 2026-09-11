import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { Feature, Question, Ticket, TicketKind } from "../shared/api";
import { criterionVerdicts, settlementOutcomes, ticketKinds } from "../shared/api";
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
  discardTicket: "discard_ticket",
  carryRepository: "carry_repository",
  setRunningExample: "set_running_example",
  rewriteTicketSummary: "rewrite_ticket_summary",
  reportStep: "report_step",
  settleSheet: "settle_sheet",
  askQuestion: "ask_question",
  settleDecision: "settle_decision",
  readGraph: "read_graph",
} as const;

/**
 * How long each piece of prose written for the developer may be.
 *
 * Bounds and not advice, and that is the whole mechanism: an agent that
 * overruns is refused on the spot, reads the bound in the refusal and cuts its
 * own prose down at the next call, with nobody in the loop. Asking nicely was
 * tried by omission and measured on a real instance: descriptions written under
 * no bound averaged 3 765 characters and reached 10 221, step reports averaged
 * 2 856, and question options averaged 175 against a schema asking for "a line".
 *
 * These are first figures, not a law. If agents start looping on refusals, the
 * bound is wrong and this is the one place to widen it. What is not adjustable
 * is that a bound exists: see ADR 0009.
 */
export const textBounds = {
  /** The standing state of things: a short paragraph. */
  context: 400,
  /** One sentence, and the point of the whole summary. */
  problem: 240,
  /** A scene needs a little more room than a claim. */
  example: 800,
  /** What a step built, read next to its test sheet; the rest is in the thread. */
  work: 600,
  /** A road, pickable at a glance. */
  optionLabel: 120,
  /** What taking that road entails. */
  optionConsequence: 400,
  /** The decor of a whole feature: a few actors and the objects they handle. */
  runningExample: 1200,
} as const;

/**
 * What an agent may write, said in the fields themselves so that it is read
 * where it applies. Two subsets and not one: a heading inside a field of 240
 * characters is noise, and a table inside a summary is detail wearing a
 * summary's clothes.
 *
 * Squad's renderer honours exactly these two, and paints Markdown as React
 * elements rather than as HTML, so nothing an agent writes can become markup
 * (`src/ui/markdown/Markdown.tsx`). A block outside the subset is not dropped:
 * its text is kept and its structure flattened, because losing what an agent
 * wrote is worse than showing it plainly.
 */
const inlineMarkdown =
  "Markdown, inline only: **bold**, *italic*, `code`, [links](url), short bullet lists and fenced code blocks. No headings, no tables, no blockquotes: their text is kept and their structure flattened.";
const fullMarkdown =
  "Markdown in full: headings, bullet and numbered lists, tables, fenced code blocks, blockquotes, links.";

export type SquadTool = (typeof squadTools)[keyof typeof squadTools];

/** A squad tool as a session sees it, prefix and all. */
export function squadToolName(tool: SquadTool): string {
  return `mcp__${squadMcpServerName}__${tool}`;
}

/**
 * The two fields every summary has. The example is the third, and it is the one
 * that varies by kind, which is why it is not here.
 */
const summaryFields = {
  context: z
    .string()
    .trim()
    .min(1)
    .max(textBounds.context)
    .describe(
      `The standing state of things this ticket starts from: what a reader needs in order to understand the problem below, and strictly nothing else. At most ${textBounds.context} characters. ${inlineMarkdown}`,
    ),
  problem: z
    .string()
    .trim()
    .min(1)
    .max(textBounds.problem)
    .describe(
      `What is wrong or missing, in ONE sentence of at most ${textBounds.problem} characters. What is wrong, not what you will do about it: what you will do is the description. ${inlineMarkdown}`,
    ),
};

/** What every ticket carries. The kind and the summary sit beside it, below. */
const createTicketCommon = {
  featureId: z.string().min(1).describe("The feature whose graph this ticket belongs to."),
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The repository this ticket is built in, among those the feature carries. Leave it out for the feature's home repository, which is where you are running.",
    ),
  title: z.string().trim().min(1).describe("One line, what the ticket delivers."),
  description: z
    .string()
    .describe(
      `The detail, for the session that will build this: what to build, in enough depth for a fresh session, with no bound on its length. This is where everything that did not fit in the summary goes. ${fullMarkdown}`,
    ),
  acceptanceCriteria: z
    .array(z.string().trim().min(1))
    .default([])
    .describe(`Checkable statements; the test sheet is built from them. ${inlineMarkdown}`),
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

/**
 * One flat shape, with the example optional and the kind rule enforced in the
 * handler.
 *
 * A `z.discriminatedUnion` on the kind said it better, and was written first.
 * It had to be undone: measured against a live server, the MCP SDK publishes
 * **no properties at all** for a tool whose input is a union, so the agent saw
 * `create_ticket` as a tool taking no arguments. Validation still worked, which
 * is why no test caught it; what was lost was every field name, every
 * description and every bound, that is to say the whole mechanism this schema
 * exists for. A rule the agent can read beats a rule the schema can express.
 */
const createTicketShape = {
  ...createTicketCommon,
  kind: z
    .enum(ticketKinds)
    .describe(
      "build for a vertical slice to construct, decision for a question to settle, which never runs, fix for a correction born of a red check.",
    ),
  summary: z
    .object({
      ...summaryFields,
      example: z
        .string()
        .trim()
        .min(1)
        .max(textBounds.example)
        .optional()
        .describe(
          `The problem above shown happening, on the running example this feature already carries and which your briefing names. Required on a \`build\` or \`decision\` ticket, and refused on a \`fix\` one, whose breakage is a red command with no business example to be shown on. Never invent a second example: the developer learns one decor per feature, and a new fiction on every ticket is the cost this field exists to remove. At most ${textBounds.example} characters. ${inlineMarkdown}`,
        ),
    })
    .describe(
      "The two or three lines the developer reads before anything else, and most of the time instead of everything else. Written for them and for nobody else: the session that builds this ticket reads the description. Bounded, and a call that overruns is refused rather than trimmed, so write short on purpose.",
    ),
};

const carryRepositoryShape = {
  featureId: z.string().min(1).describe("The feature that is to carry this repository."),
  path: z
    .string()
    .trim()
    .min(1)
    .describe(
      "A path inside the repository, as the project's documentation gives it. Squad resolves it to the repository root and matches it against the projects it already drives.",
    ),
};

const setRunningExampleShape = {
  featureId: z.string().min(1).describe("The feature this running example belongs to."),
  runningExample: z
    .string()
    .trim()
    .min(1)
    .max(textBounds.runningExample)
    .describe(
      `The decor every ticket of this feature will illustrate its own problem on: the actors of this business and the objects they handle, named and given just enough substance to be reused. Concrete and small: two or three named actors beat an abstract description. At most ${textBounds.runningExample} characters. ${inlineMarkdown}`,
    ),
};

const rewriteTicketSummaryShape = {
  featureId: z.string().min(1).describe("The feature the ticket belongs to."),
  ticketId: z.string().min(1).describe("The ticket whose summary you are rewriting."),
  summary: z
    .object({
      ...summaryFields,
      example: z
        .string()
        .trim()
        .min(1)
        .max(textBounds.example)
        .optional()
        .describe(
          "The problem shown on this feature's running example. Required on a `build` or `decision` ticket and refused on a `fix` one, exactly as when the ticket was written; squad knows which this is, so it is checked rather than asked of you.",
        ),
    })
    .describe("The summary as it should now read. It replaces the previous one whole."),
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
    .describe(`What you are asking, in one or two sentences, readable by someone who did not watch. ${inlineMarkdown}`),
  options: z
    .array(
      z.object({
        label: z
          .string()
          .trim()
          .min(1)
          .max(textBounds.optionLabel)
          .describe(
            `The road itself, in at most ${textBounds.optionLabel} characters: a line the developer can pick at a glance. What it costs does NOT go here, it goes in \`consequence\`. ${inlineMarkdown}`,
          ),
        consequence: z
          .string()
          .trim()
          .min(1)
          .max(textBounds.optionConsequence)
          .describe(
            `What taking this road entails, in at most ${textBounds.optionConsequence} characters. Required, because it is the whole difference between a list of names and a choice: without it the developer has to reconstruct what each road costs, which is the work they asked you to do. ${inlineMarkdown}`,
          ),
        illustration: z
          .string()
          .trim()
          .min(1)
          .max(textBounds.optionConsequence)
          .optional()
          .describe(
            `That consequence shown on this feature's running example, when showing it sharpens it. Leave it out rather than pad: most implementation questions have nothing useful to show, and filler here costs the developer a reading for nothing. ${inlineMarkdown}`,
          ),
      }),
    )
    .min(2)
    .describe("The roads you are offering, at least two."),
  recommendation: z
    .string()
    .trim()
    .min(1)
    .describe("The label of the option you recommend, written exactly as one of the labels above."),
  scopeChanging: z
    .boolean()
    .describe(
      "True when the answer changes what is built: the perimeter, the contract, what the ticket delivers. False when it changes only how it is built. Declare it honestly: it is what decides whether squad may answer for the developer while they are away.",
    ),
};

const reportStepShape = {
  featureId: z.string().min(1).describe("The feature the ticket belongs to."),
  ticketId: z.string().min(1).describe("The ticket whose step you are ending."),
  work: z
    .string()
    .trim()
    .min(1)
    .max(textBounds.work)
    .describe(
      `What you built and how, for someone who did not watch, in at most ${textBounds.work} characters. Bounded on purpose: this is read on the same screen as the test sheet, which is the one screen where the developer has something to do, and what does not fit belongs in this thread, which they can open. ${inlineMarkdown}`,
    ),
  coverage: z
    .array(
      z.object({
        criterionId: z
          .string()
          .min(1)
          .describe("The id of the acceptance criterion, as handed to you with the ticket."),
        verdict: z
          .enum(criterionVerdicts)
          .describe(
            "How the criterion was settled. `automated` when a test you wrote or ran checks it and will keep checking it. `checked` when no test covers it but you settled it yourself by running something: a command, a script, a query, a browser. `judgement` when only a person can tell: ergonomics, wording, a domain arbitration, an intent to confirm.",
          ),
        note: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            `What you ran and what it answered. Required on a \`checked\` criterion: it is what the developer reads instead of doing the work again. Worth writing on a \`judgement\` one too, to say what you already established around the part only a person can settle; it is shown next to that point. ${fullMarkdown} Put command output in a fenced block: it is painted as one and stays readable.`,
          ),
      }),
    )
    .describe(
      "One entry per acceptance criterion of the ticket, exactly once each and none other. Only what you declare `judgement` becomes a point the developer goes through: before writing that verdict, ask yourself whether a command, a test or a script answers, and if one does, run it and declare `checked`. Handing over what you could have settled returns the work that was delegated to you.",
    ),
  suggestions: z
    .array(z.string().trim().min(1))
    .default([])
    .describe(
      `Points you suggest checking by hand beyond the criteria: what the ticket did not foresee and only a person can judge. The same rule holds here: what you can settle yourself, settle, and say so in what you built rather than suggesting it. ${inlineMarkdown}`,
    ),
  recommendation: z
    .string()
    .trim()
    .min(1)
    .describe(`What you recommend doing next, in one or two sentences. ${inlineMarkdown}`),
};

const discardTicketShape = {
  featureId: z.string().min(1).describe("The feature the ticket belongs to."),
  ticketId: z.string().min(1).describe("The ticket to drop."),
  reason: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Why it will not be built, in one or two sentences, naming what supersedes it when something does. It is written on the ticket and is the whole of what anyone reading the graph later will have.",
    ),
};

const settleSheetShape = {
  featureId: z.string().min(1).describe("The feature the ticket belongs to."),
  ticketId: z.string().min(1).describe("The ticket whose test sheet you are settling."),
  points: z
    .array(
      z.object({
        pointId: z
          .string()
          .min(1)
          .describe("The id of the sheet point, as handed to you in the instruction."),
        outcome: z
          .enum(settlementOutcomes)
          .describe(
            "`holds` when you ran something and the point is true. `broken` when you ran something and it is false: the ticket goes back to the sub-session with what you found. `human` when only a person can **observe** it: what a screen looks like, whether a wording reads well. `decision` when nothing is wrong and a road has to be **chosen**: name the one you recommend, and say whether choosing changes what is built. Tell the last two apart, they are not owed the same thing: a verification waits for the developer, an arbitration is taken by squad under go-as-recommended. A point the sub-session called a matter of judgement is not out of your reach: if a command answers it, run it and say so.",
          ),
        note: z
          .string()
          .trim()
          .min(1)
          .describe(
            `What you ran and what it answered, or why nothing can answer. Required whatever the outcome: it is the whole of what the developer reads instead of doing the work again. ${fullMarkdown} Put command output in a fenced block: it is painted as one and stays readable.`,
          ),
        recommendation: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            `On a \`decision\`, and there only: the road you recommend, in one sentence. Required, because it is what squad takes under go-as-recommended and what the developer reads first otherwise. ${inlineMarkdown}`,
          ),
        scopeChanging: z
          .boolean()
          .optional()
          .describe(
            "On a `decision`: true when choosing changes what is built, the perimeter, what the ticket delivers. False when it changes only how. Squad never decides one that changes what is built, whatever the mode.",
          ),
      }),
    )
    .describe(
      "One entry per point of the sheet, exactly once each and none other. A sheet answered by halves would silently drop what it skipped, so it is refused.",
    ),
};

const settleDecisionShape = {
  featureId: z.string().min(1).describe("The feature the decision ticket belongs to."),
  ticketId: z.string().min(1).describe("The decision ticket the developer has just settled."),
  conclusion: z
    .string()
    .trim()
    .min(1)
    .describe(
      `What was decided, in the developer's own terms, in enough detail for a fresh session to act on it without reading this thread. ${fullMarkdown}`,
    ),
};

const readGraphShape = {
  featureId: z.string().min(1).describe("The feature whose graph to read."),
};

export interface McpDependencies {
  store: Store;
  /**
   * What the mode takes on a sheet the pass has just answered, declared by what
   * is needed of it: the ticket as it stands once squad has decided what it may.
   */
  decisions: { settled(ticket: Ticket): Ticket };
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
  /** What hands out a place: a ticket written may be one to open at once. */
  dispatch: { schedule(): void };
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
  dispatch,
  merges,
  decisions,
}: McpDependencies): McpServer {
  const server = new McpServer({ name: "squad", version: "0.1.0" });

  server.registerTool(
    squadTools.createTicket,
    {
      title: "Create a ticket",
      description:
        "Adds one node to a feature graph, with its blocking edges. Blocking edges link two tickets of the same feature and must stay acyclic: an edge that would close a loop is refused, and the answer names the loop. Every ticket carries a summary written for the developer on top of the description written for the session that builds it: the summary is bounded and a call that overruns is refused, so write it short rather than trimming it afterwards.",
      inputSchema: createTicketShape,
    },
    async (input) =>
      answer(() => {
        // A build or decision ticket illustrates itself on the feature's decor,
        // so the decor has to exist before the first one. Checked here rather
        // than asked for in the briefing: the command that cuts a spec into
        // tickets lives in the driven project, not in squad, so a refusal is
        // the only instruction squad is sure an agent reads.
        // The decor first, then the example shown on it: an agent told to show
        // its problem on an example that does not exist yet would be sent to
        // write the second before the first.
        if (input.kind !== "fix") requireRunningExample(store.requireFeature(input.featureId));
        const example = requireExampleMatchingKind(input.kind, input.summary.example ?? null);
        const ticket = store.createTicket({
          ...input,
          summary: { context: input.summary.context, problem: input.summary.problem, example },
        });
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
    squadTools.discardTicket,
    {
      title: "Drop a ticket",
      description:
        "Drops a ticket that will not be built: a duplicate, one whose branch stayed empty, one another ticket supersedes. What waited on it goes on, exactly as if it had merged, since a dead node holding its successors back stops the graph for a reason nobody can act on. It is read as dropped and never as done, nothing of it having been built. Use it instead of asking the developer to do it for you: what you leave on a test sheet reaches them as work, and dropping a node is yours to do.",
      inputSchema: discardTicketShape,
    },
    async (input) =>
      answer(() => {
        const ticket = store.discardTicket(input.featureId, input.ticketId, input.reason);
        bus.publish({ type: "graph-changed", graph: store.featureGraph(ticket.featureId) });
        return ticket;
      }),
  );

  server.registerTool(
    squadTools.carryRepository,
    {
      title: "Carry another repository",
      description:
        "Adds a repository to the ones this feature may build tickets in, so a ticket can name it. Use it when the work you are cutting up reaches beyond the repository you are running in, and the project's own documentation says where that other repository is. Only a repository squad already drives can be carried: if the path is not one of them, the answer names those it drives, and the developer registers what is missing.",
      inputSchema: carryRepositoryShape,
    },
    async (input) =>
      answer(async () => {
        const feature = await store.carryRepositoryAt(input.featureId, input.path);
        bus.publish({ type: "feature-changed", feature });
        return feature;
      }),
  );

  server.registerTool(
    squadTools.setRunningExample,
    {
      title: "Set the feature's running example",
      description:
        "Writes the one concrete example every ticket of this feature will illustrate its own problem on. Call it before writing the first ticket: `create_ticket` refuses a build or decision ticket on a feature that has none, since a ticket forced to plant its own decor cannot stay short, and a new fiction on every ticket is exactly what the summary exists to spare the developer. Call it again to correct one: a decor is settled at the same moment as the breakdown, which is when it is least certain.",
      inputSchema: setRunningExampleShape,
    },
    async (input) =>
      answer(() => {
        const before = store.requireFeature(input.featureId).runningExample;
        const feature = store.setRunningExample(input.featureId, input.runningExample);
        // Announced only when it moved: rewriting the same decor is not a
        // change, and a feature that redraws on every call would make anyone
        // watching the stream believe something happened.
        if (feature.runningExample !== before) bus.publish({ type: "feature-changed", feature });
        return feature;
      }),
  );

  server.registerTool(
    squadTools.rewriteTicketSummary,
    {
      title: "Rewrite a ticket's summary",
      description:
        "Replaces the summary of a ticket, and only its summary. Use it on a ticket written before summaries existed, and on one whose summary reads badly. It cannot touch the description on purpose: the description is the contract handed to the sub-session as its first message, so a tool able to rewrite it could change what a running ticket was asked to build without anyone seeing it. Correcting what the developer reads must never risk what gets built.",
      inputSchema: rewriteTicketSummaryShape,
    },
    async (input) =>
      answer(() => {
        // The kind decides whether an example belongs, and squad holds the kind:
        // the call states the summary, not what sort of ticket it is for.
        const ticket = store.requireTicketIn(input.featureId, input.ticketId);
        const example = requireExampleMatchingKind(
          ticket.kind,
          input.summary.example ?? null,
          ticket.title,
        );
        if (ticket.kind !== "fix") requireRunningExample(store.requireFeature(input.featureId));
        const written = store.rewriteTicketSummary(input.featureId, input.ticketId, {
          context: input.summary.context,
          problem: input.summary.problem,
          example,
        });
        bus.publish({ type: "graph-changed", graph: store.featureGraph(written.featureId) });
        return written;
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
            options: input.options.map((option) => ({
              label: option.label,
              consequence: option.consequence,
              illustration: option.illustration ?? null,
            })),
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
        "Ends the step of a ticket: what you built, how each acceptance criterion was settled, what you suggest looking at by hand, and what you recommend doing next. Only the criteria you declare `judgement`, plus your suggestions, become the test sheet the developer goes through: everything a command, a test or a script can answer is yours to run and to declare `checked`, with what it answered. A sheet full of technical points the developer cannot judge is a sheet that returns the work you were given. Reporting puts the ticket in awaiting-validation; stay available afterwards, since what a point fails on comes back to you. A step you do not report through this tool is a step squad has to ask you about again: it never concludes a ticket is done because a session stopped.",
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
    squadTools.settleSheet,
    {
      title: "Settle a test sheet",
      description:
        "Answers every point of the test sheet you were opened for: what you ran and what it said. Only the points you declare `human` reach the developer; a point that holds is checked off and a point that is broken goes back to the sub-session with your evidence. A sheet you never answer through this tool reaches the developer untouched, so giving up costs nothing but never pretend a point holds without having run something.",
      inputSchema: settleSheetShape,
    },
    async (input) =>
      answer(() => {
        // Decided before the graph goes out: the mode stops on a feature with
        // nothing left to run, so publishing a sheet whose only open point is an
        // arbitration would halt it on the decision it was about to take.
        const ticket = decisions.settled(store.settleSheet(input));
        bus.publish({ type: "graph-changed", graph: store.featureGraph(ticket.featureId) });
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
        dispatch.schedule();
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
 * The rule the schema cannot state: a `build` or `decision` ticket shows its
 * problem on the feature's running example, a `fix` ticket carries none.
 *
 * It lives here rather than in a discriminated union because a union costs the
 * agent the whole published schema (see `createTicketShape`). The refusal is
 * what an agent reads either way, so what moved is where the rule is written,
 * not whether it is enforced. It is stated in the field's description too,
 * which is published.
 */
function requireExampleMatchingKind(
  kind: TicketKind,
  example: string | null,
  title?: string,
): string | null {
  const named = title === undefined ? "this ticket" : `"${title}"`;
  if (kind === "fix") {
    if (example === null) return null;
    throw new SquadError(
      "summary_example_refused",
      400,
      `${named} is a fix ticket: what broke is a command that went red, it carries no business example, and one invented for it would be filler`,
    );
  }
  if (example !== null) return example;
  throw new SquadError(
    "summary_example_missing",
    400,
    `${named} is a ${kind} ticket: its summary must show the problem happening on this feature's running example`,
  );
}

/**
 * Refuses a ticket on a feature that has no decor yet, naming the tool that
 * writes one. The refusal is the instruction: the skill that cuts a spec into
 * tickets lives in the driven project and squad cannot change what it says, so
 * a rule that only lived in the briefing would be a rule kept by politeness.
 * It costs the first `create_ticket` of a feature one turn, and it is paid once
 * per chantier (ADR 0009).
 */
function requireRunningExample(feature: Feature): void {
  if (feature.runningExample !== null) return;
  throw new SquadError(
    "running_example_missing",
    409,
    `feature "${feature.title}" has no running example yet: call ${squadTools.setRunningExample} with the actors and objects of its business, then write this ticket again. Every ticket of a feature illustrates its own problem on that one example, so it has to exist before the first of them.`,
  );
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
