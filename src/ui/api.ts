import {
  apiRoutes,
  attachRecordedSessionRoute,
  directoriesRoute,
  featureRoute,
  mainSessionMessagesRoute,
  ticketMessagesRoute,
  mainSessionRoute,
  projectRoute,
  questionAnswerRoute,
  ticketSessionRoute,
  ticketSettlementRoute,
  ticketTestSheetRoute,
  type AnswerQuestionBody,
  type AttachRecordedSessionBody,
  type ApiErrorBody,
  type DirectoryListing,
  type ErrorCode,
  type Feature,
  type LaunchAngle,
  type OpenFeatureBody,
  type Project,
  type RecordedSession,
  type RegisterProjectBody,
  type ReviewTestSheetBody,
  type SendMainSessionMessageBody,
  type SendTicketMessageBody,
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
  orphaned_checkout:
    "Un checkout a perdu son entrée git et un précédent est déjà mis de côté : régler celui-là avant que squad n'en rouvre un autre.",
  repository_still_used:
    "Ce dépôt porte encore du travail de cette feature : il ne se retire qu'une fois qu'aucun de ses tickets ne s'y construit et que rien n'en est sorti.",
  project_not_carried:
    "Cette feature ne porte pas ce dépôt : l'ajouter à ses dépôts avant d'y écrire un ticket.",
  project_has_work_in_flight:
    "Ce projet a du travail sorti en worktree : son chemin ne change qu'une fois que plus rien n'en est sorti.",
  question_not_found: "Cette question est introuvable.",
  recorded_session_not_found:
    "Cette conversation est introuvable : claude-code ne la garde plus, ou elle a été renommée.",
  recorded_session_already_attached:
    "Cette conversation est déjà le fil d'une feature : une conversation appartient à un seul fil.",
  question_not_pending:
    "Cette question ne peut plus recevoir de réponse : elle a déjà été répondue ou abandonnée.",
  recommendation_not_an_option:
    "La recommandation de l'agent doit être l'une des options qu'il propose.",
  running_example_missing:
    "Cette feature n'a pas encore son exemple fil rouge : la session principale doit l'écrire avant le premier ticket, chaque ticket illustrant son problème dessus.",
  summary_example_missing:
    "Le résumé de ce ticket doit montrer son problème sur l'exemple fil rouge de la feature.",
  summary_example_refused:
    "Un ticket de correction ne porte pas d'exemple : ce qui a cassé est une commande passée au rouge.",
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
  ticket_not_discardable:
    "Ce ticket ne peut pas être écarté : squad travaille dessus, ou il est déjà clos.",
  ticket_not_launchable:
    "Ce ticket ne peut pas partir : une décision se tranche, et un ticket bloqué attend la fusion de ses bloqueurs.",
  sub_session_already_running: "La sous-session de ce ticket tourne déjà.",
  sub_session_not_running:
    "Aucune sous-session ne tourne sur ce ticket : le lancer ou le reprendre, ce qui n'est pas la même chose que lui écrire.",
  launch_already_requested:
    "Le lancement de ce ticket est déjà demandé : il attend une place sous les plafonds de concurrence.",
  no_step_in_progress: "Aucune sous-session ne tourne sur ce ticket : il n'y a pas d'étape à clore.",
  coverage_mismatch:
    "Le rapport doit dire, pour chaque critère d'acceptation du ticket et pour ceux-là seuls, comment il a été réglé.",
  checked_without_note:
    "Un critère réglé par l'agent doit dire ce qui a été lancé et ce que ça a répondu.",
  sheet_not_settleable: "Cette fiche n'attend aucune vérification.",
  settlement_mismatch:
    "La vérification préalable doit répondre à chaque point de la fiche, et à ceux-là seuls.",
  decision_without_a_road:
    "Un arbitrage doit nommer la voie recommandée, sans quoi personne ne peut le trancher à votre place.",
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
 * Hands a message to the sub-session running on a ticket. Refused when none is
 * running, and that refusal is the point: writing must never open a session,
 * which costs a place under the concurrency cap and a process on the machine.
 */
export async function sendTicketMessage(
  ticketId: string,
  body: SendTicketMessageBody,
): Promise<void> {
  await send(ticketMessagesRoute(ticketId), body);
}

/**
 * Launches a ticket, or takes its stopped sub-session back under the angle the
 * developer chose. Nothing comes back here either: the ticket changes state on
 * the event stream, and its sub-session writes to its own thread.
 */
export async function launchTicket(
  ticketId: string,
  angle: LaunchAngle,
  message?: string,
): Promise<void> {
  await send(ticketSessionRoute(ticketId), {
    angle,
    ...(message === undefined || message === "" ? {} : { message }),
  });
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
 * Asks squad to go through a waiting sheet before the developer does. Nothing
 * comes back: the pass runs behind the answer and what it settles arrives on the
 * event stream, like every other state change.
 */
export async function settleTestSheet(ticketId: string): Promise<void> {
  await send(ticketSettlementRoute(ticketId), {});
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

/**
 * One step of the walk through the machine's directories. Read on request like
 * the conversations below, and for a stronger reason: this is the filesystem,
 * and squad holds nothing of it.
 */
export async function listDirectory(path?: string): Promise<DirectoryListing> {
  return read<DirectoryListing>(directoriesRoute(path));
}

/**
 * The conversations claude-code has recorded, asked for rather than received on
 * the event stream: they are another program's files, and squad does not hear
 * about them changing.
 */
export async function listRecordedSessions(
  search: string,
): Promise<{ sessions: RecordedSession[]; matching: number; readable: boolean }> {
  const route =
    search.trim() === ""
      ? apiRoutes.recordedSessions
      : `${apiRoutes.recordedSessions}?search=${encodeURIComponent(search)}`;
  return read<{ sessions: RecordedSession[]; matching: number; readable: boolean }>(route);
}

/**
 * Turns a recorded conversation into a feature: its repository is registered if
 * squad did not know it, and its main session is that conversation resumed. The
 * project comes back as well as the feature, since this is where the caller
 * learns which repository it just handed squad.
 */
export async function attachRecordedSession(
  sessionId: string,
  body: AttachRecordedSessionBody,
): Promise<{ project: Project; feature: Feature }> {
  return send<{ project: Project; feature: Feature }>(attachRecordedSessionRoute(sessionId), body);
}

async function read<T>(route: string): Promise<T> {
  return answerOf<T>(await fetch(route));
}

async function send<T>(route: string, body: unknown, method: "POST" | "PUT" = "POST"): Promise<T> {
  const response = await fetch(route, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return answerOf<T>(response);
}

/**
 * What the server answered, or the refusal it answered instead. One place reads
 * an error code, whichever request brought it back.
 */
async function answerOf<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(failure?.error.code ?? "internal_error");
  }
  return (await response.json()) as T;
}
