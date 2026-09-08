import {
  apiRoutes,
  featureRoute,
  mainSessionMessagesRoute,
  mainSessionRoute,
  projectRoute,
  questionAnswerRoute,
  ticketSessionRoute,
  ticketTestSheetRoute,
  type AnswerQuestionBody,
  type ApiErrorBody,
  type ErrorCode,
  type Feature,
  type LaunchAngle,
  type OpenFeatureBody,
  type Project,
  type RegisterProjectBody,
  type ReviewTestSheetBody,
  type SendMainSessionMessageBody,
  type Settings,
  type StartMainSessionBody,
  type UpdateProjectBody,
  type UpdateSettingsBody,
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
  detached_head:
    "Ce dépôt n'est sur aucune branche : squad a besoin d'une branche par défaut d'où partir.",
  branch_not_found: "Ce dépôt n'a pas de branche de ce nom.",
  repository_still_used:
    "Ce dépôt porte encore du travail de cette feature : il ne se retire qu'une fois qu'aucun de ses tickets ne s'y construit et que rien n'en est sorti.",
  project_not_carried:
    "Cette feature ne porte pas ce dépôt : l'ajouter à ses dépôts avant d'y écrire un ticket.",
  project_has_work_in_flight:
    "Ce projet a du travail sorti en worktree : son chemin ne change qu'une fois que plus rien n'en est sorti.",
  question_not_found: "Cette question est introuvable.",
  question_not_pending:
    "Cette question ne peut plus recevoir de réponse : elle a déjà été répondue ou abandonnée.",
  recommendation_not_an_option:
    "La recommandation de l'agent doit être l'une des options qu'il propose.",
  git_failed: "Une commande git a échoué : consulter le détail côté serveur.",
  project_already_registered: "Ce dépôt est déjà enregistré comme projet.",
  project_not_found: "Ce projet est introuvable.",
  feature_not_found: "Cette feature est introuvable.",
  ticket_not_found: "Ce ticket est introuvable.",
  ticket_not_mergeable:
    "Ce ticket n'a pas d'étape validée : sa branche ne fusionne qu'une fois sa fiche de tests entièrement cochée.",
  edge_crosses_features:
    "Une arête de blocage relie deux tickets d'une même feature.",
  edge_would_create_cycle: "Cette arête fermerait une boucle dans le graphe.",
  main_session_already_running: "La session principale de cette feature tourne déjà.",
  main_session_not_running: "La session principale de cette feature ne tourne pas.",
  ticket_not_a_decision: "Seul un ticket de décision se tranche de cette façon.",
  decision_already_settled: "Cette décision a déjà été tranchée.",
  ticket_not_launchable:
    "Ce ticket ne peut pas partir : une décision se tranche, et un ticket bloqué attend la fusion de ses bloqueurs.",
  sub_session_already_running: "La sous-session de ce ticket tourne déjà.",
  launch_already_requested:
    "Le lancement de ce ticket est déjà demandé : il attend une place sous les plafonds de concurrence.",
  no_step_in_progress: "Aucune sous-session ne tourne sur ce ticket : il n'y a pas d'étape à clore.",
  coverage_mismatch:
    "Le rapport doit dire, pour chaque critère d'acceptation du ticket et pour ceux-là seuls, s'il est couvert par un test automatique.",
  test_sheet_not_found: "Ce ticket n'a pas encore de fiche de tests.",
  test_sheet_already_reviewed: "Cette fiche de tests a déjà été passée en revue.",
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

/**
 * Launches a ticket, or takes its stopped sub-session back under the angle the
 * developer chose. Nothing comes back here either: the ticket changes state on
 * the event stream, and its sub-session writes to its own thread.
 */
export async function launchTicket(ticketId: string, angle: LaunchAngle): Promise<void> {
  await send(ticketSessionRoute(ticketId), { angle });
}

/**
 * Hands back the test sheet the developer went through: a verdict and a comment
 * per point, plus a general return. Nothing comes back here: the ticket changes
 * on the event stream like everything else.
 */
export async function reviewTestSheet(
  ticketId: string,
  body: ReviewTestSheetBody,
): Promise<void> {
  await send(ticketTestSheetRoute(ticketId), body);
}

/**
 * The developer's answer to a question, which releases the agent that asked it.
 * Nothing comes back here either: the question changes on the event stream, and
 * the agent carries on writing to its own thread.
 */
export async function answerQuestion(questionId: string, body: AnswerQuestionBody): Promise<void> {
  await send(questionAnswerRoute(questionId), body);
}

/** Arms or disarms go-as-recommended on a feature, and clears what stopped it. */
export async function setGoAsRecommended(
  featureId: string,
  goAsRecommended: boolean,
): Promise<Feature> {
  const { feature } = await send<{ feature: Feature }>(
    featureRoute(featureId),
    { goAsRecommended },
    "PUT",
  );
  return feature;
}

/** Changes a project's own settings: what is left out is left as it stands. */
export async function updateProject(
  projectId: string,
  body: UpdateProjectBody,
): Promise<Project> {
  const { project } = await send<{ project: Project }>(projectRoute(projectId), body, "PUT");
  return project;
}

/** Changes squad's own settings, which are the same for every project. */
export async function updateSettings(body: UpdateSettingsBody): Promise<Settings> {
  const { settings } = await send<{ settings: Settings }>(apiRoutes.settings, body, "PUT");
  return settings;
}

async function send<T>(route: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  const response = await fetch(route, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(failure?.error.code ?? "internal_error");
  }
  return (await response.json()) as T;
}
