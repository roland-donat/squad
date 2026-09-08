import type { Feature, LaunchAngle, Project, StepReport, Ticket } from "../../shared/api";
import { failedPoints } from "../../shared/validation";
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
export function mainSessionBriefing(feature: Feature, repositories: readonly Project[]): string {
  const carried = repositories.map(
    (project) => `  - ${project.name}: ${project.path} (\`projectId: "${project.id}"\`)`,
  );
  // Read from what declares it rather than from the order of the list: the home
  // project is a field of the feature, and an order is only an order.
  const home = repositories.find((project) => project.id === feature.projectId);
  return [
    `You are the main session of the squad feature "${feature.title}", whose feature id is ${feature.id}.`,
    "",
    "Squad is the pilot station this session runs under. It holds the execution plan of this feature as a graph of tickets, and that graph is the tracker: it is not GitHub, not Linear, and not a directory of markdown files. Whenever a skill or an instruction tells you to publish tickets, break work down, or record a plan, write it into squad through the MCP tools below and nowhere else.",
    "",
    `- \`${squadToolName(squadTools.createTicket)}\` adds one ticket: its kind, title, description, acceptance criteria and blocking edges. Pass \`featureId: "${feature.id}"\` on every call. Create tickets in dependency order, blockers first, so each blocking edge can name a ticket that already exists.`,
    `- \`${squadToolName(squadTools.readGraph)}\` returns the whole graph with each ticket's computed state. Read it before adding to a graph you did not just write.`,
    `- \`${squadToolName(squadTools.settleDecision)}\` closes a decision ticket on the conclusion the developer reached, which releases the tickets it was blocking. It takes the same \`featureId\`, and settles nothing outside this feature.`,
    `- \`${squadToolName(squadTools.askQuestion)}\` asks the developer something, with the options you see and the one you recommend, and waits for their answer. Use it for what blocks you here and now; a question the rest of the breakdown depends on is a \`decision\` ticket instead, since that one belongs in the graph.`,
    `- \`${squadToolName(squadTools.carryRepository)}\` adds a repository this feature may build tickets in. It takes a path, which squad resolves against the repositories it already drives.`,
    "",
    "This feature carries these repositories, and a ticket is built in one of them:",
    ...carried,
    `Pass \`projectId\` on a ticket built anywhere other than ${home?.name ?? "the home repository"}, which is where you are running and what a ticket falls back to. A ticket naming a repository this feature does not carry is refused: carry it first, and only what squad already drives can be carried. If the work reaches a repository squad does not drive, say so rather than working around it.`,
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
export function subSessionBriefing(feature: Feature, ticket: Ticket, project: Project): string {
  return [
    `You are the sub-session of the squad ticket "${ticket.title}", whose ticket id is ${ticket.id}, on the feature "${feature.title}", whose feature id is ${feature.id}.`,
    "",
    `This ticket is built in the repository ${project.name}. Squad gave you a git worktree of it, checked out on a branch of your own, which is the current working directory: build the ticket here and commit here. Do not switch branches, do not merge, and do not touch any other checkout of this repository: squad merges your branch itself once the ticket is validated.`,
    "",
    "This feature may carry other repositories, and other tickets of it may be running there at the same time, in worktrees of their own. Yours is the only place your work belongs: what another repository needs is another ticket, and squad merges each into its own repository.",
    "",
    `- \`${squadToolName(squadTools.reportStep)}\` ends your step, and it is the only way to end one. It takes \`featureId: "${feature.id}"\`, \`ticketId: "${ticket.id}"\`, a summary of what you built, one coverage entry per acceptance criterion saying whether an automatic test really covers it, the points you suggest checking by hand on top of them, and what you recommend doing next.`,
    `- \`${squadToolName(squadTools.askQuestion)}\` asks the developer something you may not decide alone, with the options you see and the one you recommend, and does not return until they answer. Say whether the answer changes what is built or only how: squad answers an implementation question with your own recommendation when the developer has left it running unattended, and never answers one that changes what is built.`,
    `- \`${squadToolName(squadTools.createTicket)}\` writes a ticket for work your own uncovered and that does not belong in yours. Pass \`featureId: "${feature.id}"\` and \`bornOf: "${ticket.id}"\`, which is how squad counts the depth of a cascade and stops one that goes on too long. Do not use it to split what you were asked to build.`,
    `- \`${squadToolName(squadTools.readGraph)}\` returns the whole graph of the feature, with each ticket's state. Read it when you need to know what the tickets around yours are doing; pass \`featureId: "${feature.id}"\`.`,
    "",
    "Call the report tool once the work is done and committed, and stay available afterwards: what the developer finds wrong on a point comes back to you rather than to a fresh session. Squad reads no prose, so a step you do not report is a step it has to ask you about again; it never concludes a ticket is done because a session stopped.",
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
      : [
          "",
          // The ids travel with the criteria because the report declares coverage
          // under them: a session that had to go and read the graph to find them
          // would spend a turn looking up what it was already handed.
          "Acceptance criteria, each with the id to declare its coverage under:",
          ...ticket.acceptanceCriteria.map((each) => `- [${each.id}] ${each.text}`),
        ];
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
 * What squad says to a session that ended without reporting its step. The net
 * ADR 0002 asks for: the contract assumes the tool is called, so a process that
 * stopped without calling it is asked again rather than read as a ticket done.
 *
 * It says what to do in both cases on purpose. A session that finished its work
 * and simply forgot to report must not start over, and one that stopped early
 * must not report a step it did not finish.
 */
export function stepReportDemand(ticket: Ticket): string {
  return [
    "This session ended without reporting the end of its step. Squad does not conclude a ticket is done because its session stopped, so it is asking again.",
    "",
    `If the work is finished and committed on this branch, call \`${squadToolName(squadTools.reportStep)}\` now, with \`featureId: "${ticket.featureId}"\` and \`ticketId: "${ticket.id}"\`: a summary, one coverage entry per acceptance criterion, the points you suggest checking by hand, and what you recommend doing next.`,
    "",
    "If it is not finished, carry on where you left off and report when it is. Check the state of the worktree before assuming anything about what is already done.",
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

/**
 * What squad hands back to a sub-session whose test sheet came back with points
 * unchecked. It carries the comments as the developer wrote them, since those
 * comments are the whole of what says what is wrong, and it asks for a report
 * again rather than for a promise: a step ends one way in squad, and that way is
 * the report tool.
 *
 * The points are named by their wording rather than by their id: this reaches a
 * session that has the ticket in its head, and an id would send it looking the
 * wording up.
 */
export function correctionInstruction(ticket: Ticket, report: StepReport): string {
  const rejected = failedPoints(report).map((point) =>
    point.comment === null
      ? `- ${point.text}`
      : `- ${point.text}\n  The developer said: ${point.comment}`,
  );
  return [
    "The developer went through the test sheet of this step and left points unchecked. Correct them here, on this branch, in this worktree.",
    "",
    rejected.length === 0 ? "No point was named." : "What did not pass:",
    ...rejected,
    ...(report.feedback === null ? [] : ["", `Their general return: ${report.feedback}`]),
    "",
    `When it is corrected and committed, call \`${squadToolName(squadTools.reportStep)}\` again, with \`featureId: "${ticket.featureId}"\` and \`ticketId: "${ticket.id}"\`: a fresh summary, one coverage entry per acceptance criterion, the points you suggest checking by hand, and what you recommend doing next. Nothing merges until a sheet comes back with everything checked.`,
  ].join("\n");
}

/**
 * What a conflict resolution session is told about squad. It is not the ticket's
 * sub-session: it is opened for one job, in the ticket's own worktree, and it
 * ends when that job is done. It gets none of squad's tools in its briefing on
 * purpose, since it has nothing to report to the graph: whether it worked is
 * read from git by retrying the merge, never from what it says.
 */
export function conflictResolutionBriefing(
  feature: Feature,
  ticket: Ticket,
  featureBranch: string,
): string {
  return [
    `You are a merge conflict resolution session opened by squad on the ticket "${ticket.title}", on the feature "${feature.title}".`,
    "",
    `Squad tried to merge this ticket's branch into the feature branch \`${featureBranch}\` and git reported a conflict. You are in the ticket's own worktree, on the ticket's own branch, which is where the conflict is to be settled: the feature branch is left untouched, and squad retries the merge itself once you are done.`,
    "",
    "Resolve the conflict and nothing else. Keep both sides' intent, do not rewrite what neither side changed, and do not start new work: another session built this branch and its ticket is already validated.",
    "",
    "Squad reads no prose and you have nothing to report to it: it retries the merge when this session ends, and git is what says whether the conflict is gone.",
  ].join("\n");
}

/** The one job the resolution session is opened for, as its first message. */
export function conflictResolutionInstruction(featureBranch: string): string {
  return [
    `Merge the branch \`${featureBranch}\` into the branch this worktree is on, resolve every conflict it raises, and commit the merge.`,
    "",
    "Work in this worktree only. Do not switch branches, do not touch any other checkout, and do not push anything.",
    "",
    "If the conflict cannot be settled without deciding something the ticket does not answer, leave the merge unfinished rather than guessing: squad will put the ticket in front of the developer.",
  ].join("\n");
}
