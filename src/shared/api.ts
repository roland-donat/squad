import { z } from "zod";

/**
 * The contract between the squad server and everything that talks to it: the
 * browser UI and the seam tests. Nothing here may import node built-ins, since
 * this module is bundled into the browser build.
 *
 * Error messages are in English, like the rest of the code. The UI never shows
 * them: it maps `code` to French wording of its own.
 */

export const errorCodes = [
  "invalid_request",
  "path_not_found",
  "path_not_readable",
  "not_a_git_repository",
  "detached_head",
  "git_failed",
  "project_already_registered",
  "project_not_found",
  "feature_not_found",
  "ticket_not_found",
  "edge_crosses_features",
  "edge_would_create_cycle",
  "main_session_already_running",
  "main_session_not_running",
  "ticket_not_a_decision",
  "decision_already_settled",
  "ticket_not_launchable",
  "sub_session_already_running",
  "not_found",
  "data_directory_inside_project",
  "internal_error",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
  };
}

/** A git repository squad drives. */
export interface Project {
  id: string;
  name: string;
  /** Absolute path of the repository root, as resolved by git. */
  path: string;
  /**
   * The branch every feature branch starts from, and the one the main checkout
   * stays on. Declared on the row rather than read off HEAD at each use: a
   * repository someone left on another branch would otherwise silently become
   * the base of the next feature.
   */
  defaultBranch: string;
  createdAt: string;
}

/**
 * A branch of squad's own making, and where it is checked out. The two travel
 * together and are stored rather than derived, so squad finds yesterday's
 * checkout even if it would name a new one differently today. One object rather
 * than two fields, so "a branch without its checkout" cannot be written down.
 */
export interface Worktree {
  branch: string;
  /** Absolute path; never inside the driven repository, nor beside it. */
  path: string;
}

/**
 * A piece of work carried on a project, from spec to merge.
 *
 * The worktree is null until the first ticket of the feature is launched:
 * opening a feature to paste a spec into it should not check out a whole
 * repository.
 */
export interface Feature {
  id: string;
  projectId: string;
  title: string;
  /** The feature branch and its checkout, started from the default branch. */
  worktree: Worktree | null;
  createdAt: string;
}

/** What a ticket asks for. A `decision` ticket never opens a sub-session. */
export const ticketKinds = ["build", "decision", "fix"] as const;
export type TicketKind = (typeof ticketKinds)[number];

/**
 * What the pilot reads on a node. Every value is computed by the server, so the
 * interface never derives a state of its own: `merged` is recorded, `blocked`,
 * `ready` and `awaiting-decision` follow from the blocking edges and the kind.
 * The list grows as the execution states arrive; nothing here is stored under
 * these names.
 */
export const ticketStates = [
  "blocked",
  "ready",
  "running",
  "failed",
  "interrupted",
  "awaiting-decision",
  "merged",
] as const;
export type TicketState = (typeof ticketStates)[number];

/**
 * One acceptance criterion, identified in its own right: the test sheet declares
 * automatic coverage criterion by criterion, and a position in a list would stop
 * meaning the same thing the day the ticket is adjusted.
 */
export interface AcceptanceCriterion {
  id: string;
  text: string;
}

/** The only kind of node in the graph. */
export interface Ticket {
  id: string;
  featureId: string;
  kind: TicketKind;
  title: string;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  /**
   * Reserved for an outbound projection to an issue tracker, and never set:
   * squad holds the graph (ADR 0001). It exists from the first schema so that
   * adding the projection later asks for no migration.
   */
  externalId: string | null;
  /**
   * What was decided, on a `decision` ticket that has been settled from the
   * main session. Null everywhere else, and null until the decision is taken.
   */
  conclusion: string | null;
  state: TicketState;
  /**
   * The ticket branch and its checkout, started from the feature branch. Null
   * until the ticket is launched, and kept once it stops: the work is on that
   * branch, and a resume comes back onto it.
   */
  worktree: Worktree | null;
  /**
   * The sub-session that ran this ticket, kept after a failure or an
   * interruption: relaunching resumes this very session rather than opening a
   * blank one, which is what makes a restart cost the turn in flight and
   * nothing more.
   */
  sessionId: string | null;
  createdAt: string;
}

/**
 * "The blocker must be merged before the blocked one may start". The only
 * relation of the graph, hence the only thing an arrow can mean.
 */
export interface BlockingEdge {
  featureId: string;
  blockerId: string;
  blockedId: string;
}

/** A whole feature graph, which is what the API and the MCP tools hand back. */
export interface FeatureGraph {
  featureId: string;
  tickets: Ticket[];
  edges: BlockingEdge[];
}

/**
 * What one line of a session thread is. `pilot` is what the developer typed,
 * `agent` what the session said, `tool` a call it made, and `notice` what squad
 * or the runtime reported about the session itself.
 */
export const threadEntryKinds = ["pilot", "agent", "tool", "notice"] as const;
export type ThreadEntryKind = (typeof threadEntryKinds)[number];

/**
 * One line of a session thread, stored as it happens so the thread survives a
 * reload of the interface and a restart of the server. The thread is the whole
 * record of a session: squad never reconstructs it from a transcript on disk.
 */
export interface ThreadEntry {
  id: string;
  featureId: string;
  /** Null on the main session; the ticket of a sub-session once those exist. */
  ticketId: string | null;
  sessionId: string;
  kind: ThreadEntryKind;
  /** The message said, or the name of the tool called. */
  text: string;
  /**
   * What the interface folds away by default: the arguments of a tool call, the
   * detail of a failure. Null when the entry has nothing more to show.
   */
  detail: string | null;
  createdAt: string;
}

/** A main session squad is holding open right now. */
export interface MainSession {
  featureId: string;
  sessionId: string;
}

export const registerProjectBody = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  /** Taken from the branch the repository is on when it is left out. */
  defaultBranch: z.string().trim().min(1).optional(),
});
export type RegisterProjectBody = z.infer<typeof registerProjectBody>;

export const openFeatureBody = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
});
export type OpenFeatureBody = z.infer<typeof openFeatureBody>;

/**
 * The first message is optional: the developer may open the thread first and
 * paste the spec into it afterwards, which is what the interface does.
 */
export const startMainSessionBody = z.object({
  prompt: z.string().trim().min(1).optional(),
});
export type StartMainSessionBody = z.infer<typeof startMainSessionBody>;

export const sendMainSessionMessageBody = z.object({
  text: z.string().trim().min(1),
});
export type SendMainSessionMessageBody = z.infer<typeof sendMainSessionMessageBody>;

/**
 * The angle a sub-session is asked to take. A first launch is always
 * `implement`; the choice only means something on a ticket that already failed,
 * where carrying on and stepping back to diagnose are two different jobs for
 * the same session.
 */
export const launchAngles = ["implement", "diagnose"] as const;
export type LaunchAngle = (typeof launchAngles)[number];

export const launchTicketBody = z.object({
  angle: z.enum(launchAngles).default("implement"),
});
export type LaunchTicketBody = z.infer<typeof launchTicketBody>;

/** How a session ended, as the launcher reported it. */
export const agentSessionOutcomes = ["completed", "failed"] as const;
export type AgentSessionOutcome = (typeof agentSessionOutcomes)[number];

/** Everything squad has written down, as the store hands it over. */
export interface StoredState {
  projects: Project[];
  features: Feature[];
  /** One entry per feature, empty graphs included. */
  graphs: FeatureGraph[];
  /** Every thread, oldest line first, all features together. */
  threads: ThreadEntry[];
}

/**
 * The first message of a connection: what is stored, plus what is running,
 * which lives in the server's memory and nowhere else.
 */
export interface Snapshot extends StoredState {
  mainSessions: MainSession[];
}

/**
 * What the event stream carries. The first message of a connection is always a
 * `snapshot`, so a client that only listens to this stream holds the whole
 * state without ever issuing a read request.
 *
 * A graph change carries the whole graph of the feature rather than the single
 * row that moved: one added edge can flip the state of tickets it does not
 * touch, and recomputing that in the interface would put the rule in two places.
 */
export type SquadEvent =
  | ({ type: "snapshot" } & Snapshot)
  | { type: "project-registered"; project: Project }
  | { type: "feature-opened"; feature: Feature }
  // A feature changes when squad checks its branch out, which happens on the
  // first launch of one of its tickets. Sent so a client that only listens to
  // this stream still holds the whole state, as the snapshot promises.
  | { type: "feature-changed"; feature: Feature }
  | { type: "graph-changed"; graph: FeatureGraph }
  | { type: "thread-appended"; entry: ThreadEntry }
  | { type: "main-session-started"; featureId: string; sessionId: string }
  | {
      type: "main-session-ended";
      featureId: string;
      sessionId: string;
      outcome: AgentSessionOutcome;
      detail?: string;
    };

export const apiRoutes = {
  projects: "/api/projects",
  features: "/api/features",
  tickets: "/api/tickets",
  events: "/api/events",
  /**
   * Squad's MCP endpoint, the only contract between the agents and squad
   * (ADR 0002). It lives under /api like the rest of the server surface, so the
   * rule "anything the API did not claim is the interface" keeps holding.
   */
  mcp: "/api/mcp",
} as const;

export function featureGraphRoute(featureId: string): string {
  return `${apiRoutes.features}/${featureId}/graph`;
}

export function mainSessionRoute(featureId: string): string {
  return `${apiRoutes.features}/${featureId}/main-session`;
}

export function mainSessionMessagesRoute(featureId: string): string {
  return `${mainSessionRoute(featureId)}/messages`;
}

/** Where a ticket's sub-session is launched, and relaunched after a failure. */
export function ticketSessionRoute(ticketId: string): string {
  return `${apiRoutes.tickets}/${ticketId}/session`;
}
