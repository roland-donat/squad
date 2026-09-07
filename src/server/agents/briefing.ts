import type { Feature, LaunchAngle, Ticket } from "../../shared/api";
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
    "",
    "You are running in the repository's main checkout. Never switch its branch, never commit in it, and never create a worktree of your own: squad checks out a branch of its own for every ticket, and anything pointing at this checkout must keep serving what it is thought to serve. Read the repository freely; write nothing to it.",
  ].join("\n");
}

/**
 * What a sub-session is told about squad. A sub-session is blank by design: it
 * has never seen the spec, the main session's thread, nor the rest of the
 * graph. Everything it needs therefore has to be either in this briefing or in
 * the assignment below, and nothing it needs may be assumed to be in its head.
 */
export function subSessionBriefing(feature: Feature, ticket: Ticket): string {
  return [
    `You are the sub-session of the squad ticket "${ticket.title}", whose ticket id is ${ticket.id}, on the feature "${feature.title}", whose feature id is ${feature.id}.`,
    "",
    "Squad is the pilot station this session runs under. It gave you a git worktree of your own, checked out on a branch of your own, which is the current working directory: build the ticket here and commit here. Do not switch branches, do not merge, and do not touch any other checkout of this repository: squad merges your branch itself once the ticket is validated.",
    "",
    "Other tickets of this feature may be running at the same time, in worktrees of their own. Your branch is the only place your work belongs.",
    "",
    `- \`${squadToolName(squadTools.readGraph)}\` returns the whole graph of the feature, with each ticket's state. Read it when you need to know what the tickets around yours are doing; pass \`featureId: "${feature.id}"\`.`,
    "",
    "The ticket you are building is handed to you as the first message of this thread. It is the whole of what was asked, acceptance criteria included.",
  ].join("\n");
}

/**
 * The ticket itself, handed as the first message rather than left for the
 * session to fetch: a blank session that has to go and read the graph before it
 * knows what it is building spends a turn discovering its own job.
 */
export function ticketAssignment(ticket: Ticket): string {
  const criteria =
    ticket.acceptanceCriteria.length === 0
      ? ["", "No acceptance criterion was written on this ticket."]
      : ["", "Acceptance criteria:", ...ticket.acceptanceCriteria.map((each) => `- ${each.text}`)];
  return [
    `Build this ticket, of kind \`${ticket.kind}\`.`,
    "",
    `# ${ticket.title}`,
    "",
    ticket.description === "" ? "No description was written on this ticket." : ticket.description,
    ...criteria,
  ].join("\n");
}

/**
 * What squad says when it takes a stopped sub-session back. The session still
 * holds everything the first attempt learnt, so this says what changed rather
 * than restating the ticket: repeating the assignment would read as a new job
 * and invite the session to start over.
 */
export function resumeInstruction(angle: LaunchAngle, why: string): string {
  const shared = `This session was resumed by squad: ${why} Your worktree and your branch are as you left them.`;
  if (angle === "diagnose") {
    return [
      shared,
      "",
      "Stop implementing and diagnose instead. Find out what actually goes wrong before changing anything else: reproduce it, narrow it down to the smallest failing case, and say what the cause is. Only then decide what to do about it.",
    ].join("\n");
  }
  return [
    shared,
    "",
    "Carry on with the implementation from where it stopped. Check the state of the worktree before assuming anything about what is already done.",
  ].join("\n");
}
