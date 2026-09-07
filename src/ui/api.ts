import {
  apiRoutes,
  mainSessionMessagesRoute,
  mainSessionRoute,
  type ApiErrorBody,
  type ErrorCode,
  type Feature,
  type OpenFeatureBody,
  type Project,
  type RegisterProjectBody,
  type SendMainSessionMessageBody,
  type StartMainSessionBody,
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
  feature_not_found: "Cette feature est introuvable.",
  ticket_not_found: "Ce ticket est introuvable.",
  edge_crosses_features:
    "Une arête de blocage relie deux tickets d'une même feature.",
  edge_would_create_cycle: "Cette arête fermerait une boucle dans le graphe.",
  main_session_already_running: "La session principale de cette feature tourne déjà.",
  main_session_not_running: "La session principale de cette feature ne tourne pas.",
  ticket_not_a_decision: "Seul un ticket de décision se tranche de cette façon.",
  decision_already_settled: "Cette décision a déjà été tranchée.",
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

/** Opens the main session of a feature, with the first message to hand it. */
export async function startMainSession(
  featureId: string,
  body: StartMainSessionBody,
): Promise<void> {
  await send(mainSessionRoute(featureId), body);
}

/**
 * Hands a message to the session that is already running. Nothing comes back
 * here: the answer arrives on the event stream, line by line.
 */
export async function sendMainSessionMessage(
  featureId: string,
  body: SendMainSessionMessageBody,
): Promise<void> {
  await send(mainSessionMessagesRoute(featureId), body);
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
