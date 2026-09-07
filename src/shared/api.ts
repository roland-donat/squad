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

export interface Snapshot {
  projects: Project[];
  features: Feature[];
}

/**
 * What the event stream carries. The first message of a connection is always a
 * `snapshot`, so a client that only listens to this stream holds the whole
 * state without ever issuing a read request.
 */
export type SquadEvent =
  | ({ type: "snapshot" } & Snapshot)
  | { type: "project-registered"; project: Project }
  | { type: "feature-opened"; feature: Feature };

export const apiRoutes = {
  projects: "/api/projects",
  features: "/api/features",
  events: "/api/events",
} as const;
