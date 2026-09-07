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
  "project_already_registered",
  "project_not_found",
  "feature_not_found",
  "ticket_not_found",
  "edge_crosses_features",
  "edge_would_create_cycle",
  "main_session_already_running",
  "agent_launcher_unavailable",
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
  createdAt: string;
}

/** A piece of work carried on a project, from spec to merge. */
export interface Feature {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
}

/** What a ticket asks for. A `decision` ticket never opens a sub-session. */
export const ticketKinds = ["build", "decision", "fix"] as const;
export type TicketKind = (typeof ticketKinds)[number];

/**
 * What the pilot reads on a node. Every value is computed by the server, so the
 * interface never derives a state of its own: `merged` is recorded, `blocked`
 * and `ready` follow from the blocking edges. The list grows as the execution
 * states arrive; nothing here is stored under these names.
 */
export const ticketStates = ["blocked", "ready", "merged"] as const;
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
  state: TicketState;
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

export const registerProjectBody = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
});
export type RegisterProjectBody = z.infer<typeof registerProjectBody>;

export const openFeatureBody = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
});
export type OpenFeatureBody = z.infer<typeof openFeatureBody>;

export const startMainSessionBody = z.object({
  prompt: z.string().trim().min(1),
});
export type StartMainSessionBody = z.infer<typeof startMainSessionBody>;

/** How a session ended, as the launcher reported it. */
export const agentSessionOutcomes = ["completed", "failed"] as const;
export type AgentSessionOutcome = (typeof agentSessionOutcomes)[number];

export interface Snapshot {
  projects: Project[];
  features: Feature[];
  /** One entry per feature, empty graphs included. */
  graphs: FeatureGraph[];
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
  | { type: "graph-changed"; graph: FeatureGraph }
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
