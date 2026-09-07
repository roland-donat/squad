import {
  apiRoutes,
  type ApiErrorBody,
  type ErrorCode,
  type Feature,
  type OpenFeatureBody,
  type Project,
  type RegisterProjectBody,
} from "../shared/api";

/**
 * The only way the interface talks to squad. It never reaches the disk nor the
 * database: every action goes through these requests, every state change comes
 * back through the event stream.
 */

/** French wording shown for each error code the server may return. */
const wording: Record<ErrorCode, string> = {
  invalid_request: "La demande est incomplète : vérifier les champs saisis.",
  path_not_found: "Ce chemin n'existe pas sur cette machine.",
  path_not_readable: "Ce chemin existe mais squad ne peut pas le lire.",
  not_a_git_repository: "Ce chemin n'est pas un dépôt git.",
  project_already_registered: "Ce dépôt est déjà enregistré comme projet.",
  project_not_found: "Ce projet est introuvable.",
  not_found: "Cette route n'existe pas.",
  data_directory_inside_project:
    "La base de squad se trouve dans ce dépôt : squad refuse de piloter un dépôt qui la contient.",
  internal_error: "Le serveur a rencontré une erreur inattendue.",
};

export class ApiError extends Error {
  constructor(readonly code: ErrorCode) {
    super(wording[code]);
    this.name = "ApiError";
  }
}

export async function registerProject(body: RegisterProjectBody): Promise<Project> {
  const { project } = await send<{ project: Project }>(apiRoutes.projects, body);
  return project;
}

export async function openFeature(body: OpenFeatureBody): Promise<Feature> {
  const { feature } = await send<{ feature: Feature }>(apiRoutes.features, body);
  return feature;
}

async function send<T>(route: string, body: unknown): Promise<T> {
  const response = await fetch(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(failure?.error.code ?? "internal_error");
  }
  return (await response.json()) as T;
}
