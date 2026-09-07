import type { Feature } from "../../shared/api";
import { squadToolName, squadTools } from "../mcp";

/**
 * What squad tells a session about squad, appended to claude-code's own system
 * prompt rather than said in the thread: it is context, not a message, and the
 * developer reading the thread should see their own exchange and nothing else.
 *
 * Two things make this briefing necessary rather than decorative. The tools take
 * a feature id, and nothing in the working directory carries it, so a session
 * that was not told it cannot write a single ticket. And the skills that do the
 * cutting up publish to "the configured tracker": unless the session is told the
 * tracker is squad, `/to-tickets` files GitHub issues and the graph stays empty.
 */
export function mainSessionBriefing(feature: Feature): string {
  return [
    `You are the main session of the squad feature "${feature.title}", whose feature id is ${feature.id}.`,
    "",
    "Squad is the pilot station this session runs under. It holds the execution plan of this feature as a graph of tickets, and that graph is the tracker: it is not GitHub, not Linear, and not a directory of markdown files. Whenever a skill or an instruction tells you to publish tickets, break work down, or record a plan, write it into squad through the MCP tools below and nowhere else.",
    "",
    `- \`${squadToolName(squadTools.createTicket)}\` adds one ticket: its kind, title, description, acceptance criteria and blocking edges. Pass \`featureId: "${feature.id}"\` on every call. Create tickets in dependency order, blockers first, so each blocking edge can name a ticket that already exists.`,
    `- \`${squadToolName(squadTools.readGraph)}\` returns the whole graph with each ticket's computed state. Read it before adding to a graph you did not just write.`,
    `- \`${squadToolName(squadTools.settleDecision)}\` closes a decision ticket on the conclusion the developer reached, which releases the tickets it was blocking. It takes the same \`featureId\`, and settles nothing outside this feature.`,
    "",
    "A ticket carries a kind: `build` for a vertical slice to construct, `decision` for a question only the developer can answer, `fix` for a correction born of a red check. A `decision` ticket is never implemented and never opens a session of its own: it waits in the graph until the developer settles it in this thread. The moment they do, call the settle tool with their conclusion in their own terms, in enough detail for a fresh session to act on it without reading this thread. Squad parses no prose: a decision you do not write through that tool never reaches the graph.",
    "",
    "This thread is where the developer pastes their spec, has the work cut up, adjusts the breakdown and settles decisions. It is not where the tickets get implemented: squad opens a session of its own for each of those.",
  ].join("\n");
}
