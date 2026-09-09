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
  "launch_already_requested",
  "no_step_in_progress",
  "coverage_mismatch",
  "checked_without_note",
  "sheet_not_settleable",
  "settlement_mismatch",
  "decision_without_a_road",
  "test_sheet_not_found",
  "test_sheet_already_reviewed",
  "ticket_not_mergeable",
  "branch_not_found",
  "project_has_work_in_flight",
  "project_not_carried",
  "repository_still_used",
  "recorded_session_not_found",
  "recorded_session_already_attached",
  "question_not_found",
  "question_not_pending",
  "recommendation_not_an_option",
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
  /**
   * How many sub-sessions one feature of this project may run at once. Declared
   * on the project and applied to each of its features separately: two features
   * of the same repository are two pieces of work, and neither has to wait on
   * the other. The machine-wide cap is what bounds their sum.
   */
  featureConcurrencyCap: number;
  /**
   * What squad runs on the feature worktree after every ticket merge: the
   * project's own typing and test pass, as one command line. Null when none is
   * declared, and then nothing runs and no merge is ever held back by a check
   * that does not exist. Declaring it is what makes squad able to catch what two
   * separately green tickets break together, so it is optional in the schema
   * only.
   */
  verifyCommand: string | null;
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
 * Why squad stopped driving a feature on its own. The four are the whole list,
 * and each names something no agent may decide in the developer's place: a
 * question that changes what is built, a decision ticket, work that stopped,
 * and a cascade of agent-written tickets that reached its declared depth.
 */
export const autonomyHaltReasons = [
  "scope-question",
  "decision",
  "failure",
  "depth-cap",
] as const;
export type AutonomyHaltReason = (typeof autonomyHaltReasons)[number];

/** What stopped the mode, when, and on what. The interface words the reason. */
export interface AutonomyHalt {
  reason: AutonomyHaltReason;
  /** What it stopped on: a ticket's title, a question's statement. */
  detail: string;
  at: string;
}

/**
 * One repository a feature carries, with what squad opened in it. A feature
 * spans several of them when the work does: an interface changed in one
 * repository and its callers in another are one piece of work, and holding
 * them in one graph is what lets "this ticket waits for that one" mean
 * something across repositories.
 *
 * The worktree is null until the first ticket of this repository is launched:
 * carrying a repository must not cost a checkout of it before anything is
 * built there.
 */
export interface FeatureRepository {
  projectId: string;
  /** The feature branch in that repository, and where it is checked out. */
  worktree: Worktree | null;
  /**
   * The pull request squad opened on this repository once every ticket of the
   * graph had merged, or null while the feature is still being built. Written
   * down rather than asked of the forge at each read: it is what says this
   * repository was delivered, and it must stay true when nothing can reach the
   * network.
   */
  pullRequestUrl: string | null;
}

/**
 * A piece of work, from spec to merge. It has a home project, which is where
 * its main session runs and where its tickets are built unless they say
 * otherwise, and it carries every repository its tickets may touch, that home
 * project included.
 */
export interface Feature {
  id: string;
  /** The home project: where the main session runs, and a ticket's default. */
  projectId: string;
  title: string;
  /** Every repository this feature carries, its home project first. */
  repositories: FeatureRepository[];
  /**
   * The recorded conversation this feature's main session was resumed from, or
   * null when it was opened blank. Written down rather than read off the running
   * session: it is what says a conversation already belongs to a feature, and it
   * has to say so when nothing is running.
   */
  resumedSessionId: string | null;
  /**
   * Whether squad drives this feature on its own: it launches what the frontier
   * allows without being asked, and answers an agent's implementation questions
   * with that agent's own recommendation. Declared per feature rather than per
   * project or machine, because it says how much of one piece of work the
   * developer is willing to be away from, and that is not a property of the
   * repository.
   */
  goAsRecommended: boolean;
  /**
   * Why squad stopped driving, or null while it drives. It is written when
   * squad meets something only the developer can settle, and cleared when they
   * arm the mode again: nothing else restarts a night of autonomy.
   */
  autonomyHalt: AutonomyHalt | null;
  createdAt: string;
}

/** What a ticket asks for. A `decision` ticket never opens a sub-session. */
export const ticketKinds = ["build", "decision", "fix"] as const;
export type TicketKind = (typeof ticketKinds)[number];

/**
 * What the pilot reads on a node. Every value is computed by the server, so the
 * interface never derives a state of its own: `merged` is recorded, `blocked`,
 * `ready` and `awaiting-decision` follow from the blocking edges and the kind,
 * and `queued` is a launch squad accepted and has not opened yet.
 *
 * `merging` is the whole tail of a validated step: the sub-session is closed,
 * the branch goes back into the feature branch, and the project's verification
 * runs on it. `conflict` is where that tail stops when a merge conflicts twice,
 * the second time after a resolution session was given the ticket's worktree to
 * sort it out. Nothing is stored under these names.
 */
export const ticketStates = [
  "blocked",
  "ready",
  "queued",
  "running",
  "awaiting-validation",
  // Squad's own pass on the sheet, and the wait for a place to run it in.
  "settling",
  "settling-queued",
  "merging",
  "failed",
  "interrupted",
  "conflict",
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

/**
 * How an acceptance criterion was settled, as the sub-session declared it when
 * it ended its step.
 *
 * Three verdicts and not two, because between "a test covers it" and "only a
 * person can tell" lies everything an agent can settle by running something,
 * and that is most of it. A criterion nobody automated but that a command
 * answers is the agent's to run, not the developer's to check by hand: handing
 * it over returns the work that was delegated, in a form nobody but the agent
 * can act on.
 */
export const criterionVerdicts = ["automated", "checked", "judgement"] as const;
export type CriterionVerdict = (typeof criterionVerdicts)[number];

export interface CriterionCoverage {
  criterionId: string;
  /** The criterion as it read when the step was reported. */
  text: string;
  /**
   * `automated` when an automatic test really covers it, `checked` when the
   * agent settled it itself by running something, `judgement` when only a
   * person can: ergonomics, wording, a domain arbitration, an intent to
   * confirm. Only the last kind reaches the test sheet.
   */
  verdict: CriterionVerdict;
  /**
   * What the agent ran and what it answered. On a `checked` criterion it is the
   * whole of what the developer reads instead of doing the work again, so one
   * without it is refused. On a `judgement` criterion it is what was already
   * established around the part only a person can settle, and it is shown next
   * to that point on the sheet rather than dropped.
   */
  note: string | null;
}

/**
 * Where a point of the test sheet comes from. `pending` is what a point reads as
 * before the developer has been through the sheet; the two others are what
 * checking it or leaving it unchecked records.
 */
export const sheetVerdicts = ["pending", "passed", "failed"] as const;
export type SheetVerdict = (typeof sheetVerdicts)[number];

/**
 * One thing a human has to check by hand. It comes either from an acceptance
 * criterion no automatic test covers, and then it names that criterion, or from
 * the agent suggesting something the ticket did not ask for, and then it names
 * none: the two are told apart by a declared field, never by their wording.
 */
export interface TestSheetPoint {
  id: string;
  /** The acceptance criterion this point stands for, or null when suggested. */
  criterionId: string | null;
  text: string;
  verdict: SheetVerdict;
  /** What the developer said about this point, once they went through it. */
  comment: string | null;
  /**
   * What squad's settling pass found on this point, before anyone was woken.
   * Null while no pass has been through, which is also what a sheet looks like
   * when the pass failed: the fall-back is towards the developer, never away.
   */
  settlement: PointSettlement | null;
}

/**
 * How a settling pass answered one point of a test sheet.
 *
 * `holds` and `broken` are verdicts squad may reach on its own, and each turns
 * into the developer's own vocabulary: a point that holds is checked, a point
 * that is broken goes back to the sub-session with the evidence.
 *
 * The last two are what a person is for, and they are not the same thing.
 * `human` is a **verification** nobody but a person can make: what a screen
 * looks like, whether a wording reads well. `decision` is an **arbitration**:
 * nothing is wrong, two roads are open and one has to be chosen. Told apart
 * because they are not owed the same thing: a verification waits for the
 * developer however long it takes, while an arbitration that does not change
 * what is built is taken by squad under go-as-recommended, exactly as it
 * answers a question an agent asks.
 */
export const settlementOutcomes = ["holds", "broken", "human", "decision"] as const;
export type SettlementOutcome = (typeof settlementOutcomes)[number];

export interface PointSettlement {
  outcome: SettlementOutcome;
  /**
   * What was run and what it answered, or why nothing can answer. Required
   * whatever the outcome: a settlement without it is an assertion, and the whole
   * value of the pass is that the developer can read what it did instead of
   * doing it again.
   */
  note: string;
  /**
   * On a `decision`, the road the pass recommends, in its own words. It is what
   * squad takes under go-as-recommended, and what the developer reads first
   * otherwise. Null on every other outcome.
   */
  recommendation: string | null;
  /**
   * On a `decision`, whether choosing changes what is built rather than how.
   * Squad never decides one of those for the developer, whatever the mode.
   */
  scopeChanging: boolean;
}

/**
 * What a sub-session hands over when its step ends: what it built, what it
 * automated, what it suggests looking at, and what it recommends doing next.
 * The test sheet is derived from it once and written down, so a ticket whose
 * criteria are adjusted afterwards does not silently change what was checked.
 */
export interface StepReport {
  id: string;
  ticketId: string;
  /** The sub-session that reported, which is the one a correction goes back to. */
  sessionId: string;
  summary: string;
  /** What the agent recommends doing next, in its own terms. */
  recommendation: string;
  /** One entry per acceptance criterion of the ticket, in the ticket's order. */
  coverage: CriterionCoverage[];
  /** The test sheet: uncovered criteria first, then the agent's suggestions. */
  sheet: TestSheetPoint[];
  /** The developer's general return, written when they went through the sheet. */
  feedback: string | null;
  /** When the developer went through the sheet; null while it is still waiting. */
  reviewedAt: string | null;
  createdAt: string;
}

/** The only kind of node in the graph. */
export interface Ticket {
  id: string;
  featureId: string;
  /**
   * The repository this ticket is built in, one of those its feature carries.
   * Written on the row rather than read from the feature at each use: a feature
   * carries several, and which one a ticket belongs to is the whole of what
   * tells its sub-session where to work and its branch where to go home.
   */
  projectId: string;
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
  /**
   * When the developer asked for this launch, on a ticket squad has accepted
   * but not opened yet: the caps were full. Null the rest of the time, and
   * cleared the moment the sub-session opens. It is also what orders the
   * waiting launches, so the one that has waited longest goes first.
   */
  queuedAt: string | null;
  /**
   * How many tickets deep in a cascade of agent-written work this one sits. A
   * ticket the main session wrote is 0; one an agent asked for while building
   * another is that other's depth plus one. Written on the row rather than
   * walked back through the graph at each read: the ticket it was born of may
   * be gone, and what bounds a cascade must not depend on its ancestors still
   * being there.
   */
  generation: number;
  /**
   * The last step this ticket's sub-session reported, with its test sheet. Null
   * until a step is reported; the latest one afterwards, since a ticket
   * corrected after a red sheet reports its step again.
   */
  stepReport: StepReport | null;
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

/**
 * One entry of a directory listing: a directory, and never anything else.
 *
 * A file is not offered because a project is a repository, and nothing about a
 * file could be chosen here. Entries whose name starts with a dot are left out
 * as well: `.git` at the top of every repository would be the noisiest of them,
 * and choosing one has never been the point.
 */
export interface DirectoryEntry {
  name: string;
  /** Absolute, so choosing it needs nothing but this. */
  path: string;
  /**
   * Whether a repository sits here, read off the presence of `.git`. A file
   * counts as much as a directory: that is what a worktree leaves behind.
   */
  isRepository: boolean;
}

/**
 * One step of the walk: the directory reached, the way back up, and what it
 * holds. Nothing recursive, and no file content: squad reads the shape of the
 * filesystem here and nothing of what is in it.
 */
export interface DirectoryListing {
  /** The directory itself, absolute and free of symlinks. */
  path: string;
  /** Where up leads, or null at the root of the filesystem. */
  parent: string | null;
  isRepository: boolean;
  /**
   * What a project registered here would be called, or null outside a
   * repository: the name it carries on its forge when it has an `origin`, the
   * directory's own otherwise. Proposed and never imposed, the field taking it
   * only until someone types over it.
   */
  suggestedName: string | null;
  /** Its directories, by name. */
  entries: DirectoryEntry[];
}

/**
 * A conversation claude-code has already recorded, as squad reads it to offer a
 * feature that starts from work already done rather than from an empty thread.
 * Everything here identifies the session; nothing here is what was said in it,
 * which squad never reads and never turns into state of its own.
 */
export interface RecordedSession {
  /** The session id, which is what resuming it runs on. */
  id: string;
  /** Where it ran, which is not always the root of the repository it ran in. */
  cwd: string;
  /**
   * The repository that directory belongs to, found by walking up to the
   * nearest `.git`, or null when it belongs to none. What the reader recognises
   * a session by, and what attaching it registers.
   */
  repository: string | null;
  branch: string | null;
  /** What it was named, when it was named. */
  title: string | null;
  /** The opening of what was first asked of it, cut short. */
  firstMessage: string | null;
  /** When it was last written to, which is what "the most recent" means. */
  recordedAt: string;
  /** How big its transcript is: resuming a large one is paid for at the first turn. */
  bytes: number;
}

/** A main session squad is holding open right now. */
export interface MainSession {
  featureId: string;
  sessionId: string;
}

/**
 * Where a question stands. `abandoned` is what a question asked by a session
 * that is no longer there becomes: squad settles them at startup rather than
 * leaving a question in front of the developer whose answer would reach nobody.
 */
export const questionStates = ["pending", "answered", "abandoned"] as const;
export type QuestionState = (typeof questionStates)[number];

/** Who answered: the developer, or squad on their behalf in go-as-recommended. */
export const answerSources = ["developer", "squad"] as const;
export type AnswerSource = (typeof answerSources)[number];

/**
 * A question an agent asked, and what it was answered. The tool call that asks
 * it blocks until the answer is written here, which is what makes the interface
 * the place questions are settled rather than a terminal nobody is watching.
 *
 * The options and the recommendation travel with the question because
 * go-as-recommended answers it by picking the recommendation: an answer squad
 * gives on its own has to be one the agent itself put on the table.
 */
export interface Question {
  id: string;
  featureId: string;
  /** The ticket whose sub-session asked, or null when the main session did. */
  ticketId: string | null;
  sessionId: string;
  /** The question itself, as the agent worded it. */
  prompt: string;
  /** What the agent offers to choose from, in the order it wrote them. */
  options: string[];
  /** The option the agent recommends; always one of the options above. */
  recommendation: string;
  /**
   * Whether the answer changes what is built rather than only how. A
   * scope-changing question waits for the developer whatever the mode, since
   * the perimeter is the one thing squad never settles on its own.
   */
  scopeChanging: boolean;
  state: QuestionState;
  /** What was answered; free wording, so the developer is not held to the options. */
  answer: string | null;
  answeredBy: AnswerSource | null;
  answeredAt: string | null;
  createdAt: string;
}

/**
 * A cap of zero would be a way of stopping everything that nobody asked for,
 * and one nothing else in squad would explain: a feature would sit still with
 * every ticket ready and no reason on screen.
 */
const concurrencyCapSchema = z.number().int().min(1);

/**
 * The command line squad runs to check the feature branch, or null to declare
 * that this project has none. Trimmed to nothing reads as null rather than as a
 * command that runs a shell and returns green: an empty check that always passes
 * is the one failure nobody would notice.
 */
const verifyCommandSchema = z
  .string()
  .trim()
  .nullable()
  .transform((command) => (command === null || command === "" ? null : command));

/**
 * What the caps are until someone declares otherwise. Declared here rather than
 * in the schema alone, so the column default, the value read back from a row
 * written before these columns existed, and what the interface shows before its
 * first snapshot are one and the same number.
 *
 * Four sub-sessions on the machine: each is a claude-code process doing real
 * work, and a laptop hosting more of them spends its time swapping. Three per
 * feature: wide enough for a usual frontier to move on several fronts, narrow
 * enough that one piece of work does not take the whole machine.
 */
export const defaultConcurrencyCaps = { machine: 4, feature: 3 } as const;

/**
 * How deep tickets born of tickets may go before squad stops and asks. Zero is
 * allowed and means "nothing an agent asked for runs unattended": the tickets
 * are still written, the mode simply stops on the first of them.
 *
 * Three by default: a ticket that uncovers work, whose work uncovers more, is
 * an ordinary Tuesday; a fourth level is a cascade nobody asked for.
 */
const generationDepthCapSchema = z.number().int().min(0);
export const defaultGenerationDepthCap = 3;

export const registerProjectBody = z.object({
  path: z.string().trim().min(1),
  name: z.string().trim().min(1).optional(),
  /** Taken from the branch the repository is on when it is left out. */
  defaultBranch: z.string().trim().min(1).optional(),
  featureConcurrencyCap: concurrencyCapSchema.optional(),
  verifyCommand: verifyCommandSchema.optional(),
});
export type RegisterProjectBody = z.infer<typeof registerProjectBody>;

/** What can be changed on a registered project. What is left out is left alone. */
export const updateProjectBody = z.object({
  /** Resolved to a repository root again, exactly as a registration is. */
  path: z.string().trim().min(1).optional(),
  /** Checked against the repository: a branch that is not there is refused. */
  defaultBranch: z.string().trim().min(1).optional(),
  featureConcurrencyCap: concurrencyCapSchema.optional(),
  verifyCommand: verifyCommandSchema.optional(),
});
export type UpdateProjectBody = z.infer<typeof updateProjectBody>;

export const openFeatureBody = z.object({
  /** The home project: where the main session runs, and a ticket's default. */
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  /** Other registered projects this feature may build tickets in. */
  otherProjectIds: z.array(z.string().trim().min(1)).default([]),
  /**
   * Whether squad drives this feature on its own from the moment it exists.
   * Declared here rather than set by a second request: how much of a piece of
   * work one is willing to be away from is decided when the work is opened, and
   * a feature that exists for a moment under a mode nobody chose is a feature
   * squad could act on before being told to.
   */
  goAsRecommended: z.boolean().default(false),
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

/**
 * What the developer says of a test sheet: one verdict and one comment per
 * point, plus a general return. A point left unchecked is a point that did not
 * pass, and its comment is what the sub-session will be asked to correct.
 */
export const reviewTestSheetBody = z.object({
  points: z
    .array(
      z.object({
        id: z.string().min(1),
        passed: z.boolean(),
        /** Empty means nothing was said about this point. */
        comment: z.string().trim().default(""),
      }),
    )
    .default([]),
  feedback: z.string().trim().default(""),
});
export type ReviewTestSheetBody = z.infer<typeof reviewTestSheetBody>;

/**
 * What the developer says of a question. Free wording rather than the index of
 * an option: the options are what the agent thought of, and an answer it did
 * not think of is exactly the one worth being able to give.
 */
export const answerQuestionBody = z.object({
  answer: z.string().trim().min(1),
});
export type AnswerQuestionBody = z.infer<typeof answerQuestionBody>;

/**
 * What can be changed on an open feature. Arming the mode again is also what
 * clears a halt: squad stopped for a reason, and only the developer says the
 * reason is dealt with.
 */
export const updateFeatureBody = z.object({
  goAsRecommended: z.boolean().optional(),
  /**
   * Every repository the feature carries, its home project included: what is
   * left out is dropped, and a repository holding a checkout is not dropped.
   */
  projectIds: z.array(z.string().trim().min(1)).optional(),
});
export type UpdateFeatureBody = z.infer<typeof updateFeatureBody>;

/**
 * Which ground the interface is drawn on. `system` is not a third palette but
 * the absence of a choice: the browser's own setting then decides, and keeps
 * deciding when it changes.
 */
export const themes = ["system", "light", "dark"] as const;
export type Theme = (typeof themes)[number];

/**
 * What squad is configured with, machine-wide. Everything here is what the
 * developer sets once and squad reads at every alert; nothing is derived from
 * the environment, so what is in force is always readable through the API.
 */
export interface Settings {
  /** Where an alert is posted besides the desktop, or null when none is set. */
  webhookUrl: string | null;
  /** Whether an alert also raises a notification on this machine's desktop. */
  desktopNotifications: boolean;
  /**
   * How many sub-sessions may run at once on this machine, every feature and
   * every project together. The more restrictive of this and the project's own
   * cap is the one that decides.
   */
  machineConcurrencyCap: number;
  /**
   * How deep a cascade of agent-written tickets may go before squad stops
   * driving on its own. It bounds the depth, never the number of tickets: an
   * agent may write ten tickets while building one, and that is one generation.
   */
  generationDepthCap: number;
  /**
   * Which ground the interface is drawn on. Held here rather than in the
   * browser alone, so that what is in force is read through the same surface as
   * the rest of the settings.
   */
  theme: Theme;
}

export const updateSettingsBody = z.object({
  /** Null clears it: an alert then goes to the desktop and nowhere else. */
  webhookUrl: z.url().nullable().optional(),
  desktopNotifications: z.boolean().optional(),
  machineConcurrencyCap: concurrencyCapSchema.optional(),
  generationDepthCap: generationDepthCapSchema.optional(),
  theme: z.enum(themes).optional(),
});
export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>;

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
  /** Every question ever asked, oldest first, answered ones included. */
  questions: Question[];
  settings: Settings;
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
  // A project changes when its settings do, the concurrency cap among them.
  | { type: "project-changed"; project: Project }
  | { type: "feature-opened"; feature: Feature }
  // A feature changes when squad checks its branch out, which happens on the
  // first launch of one of its tickets. Sent so a client that only listens to
  // this stream still holds the whole state, as the snapshot promises.
  | { type: "feature-changed"; feature: Feature }
  | { type: "graph-changed"; graph: FeatureGraph }
  | { type: "thread-appended"; entry: ThreadEntry }
  // One event for a question asked, answered or abandoned: what a client does
  // with it is the same in all three cases, which is to hold the question it
  // carries in place of the one it had.
  | { type: "question-changed"; question: Question }
  | { type: "settings-changed"; settings: Settings }
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
  settings: "/api/settings",
  questions: "/api/questions",
  /**
   * The conversations claude-code has recorded, read on request rather than
   * carried on the event stream: they are another program's storage, they change
   * without squad hearing about it, and a stale list is worse than one asked for.
   */
  recordedSessions: "/api/recorded-sessions",
  /**
   * The directories of this machine, walked one step at a time so a repository
   * can be chosen rather than typed. Read on request like the conversations
   * above, and for a stronger reason: this is the filesystem, which changes
   * without squad hearing about it and which squad holds nothing of.
   */
  directories: "/api/directories",
  /**
   * Squad's MCP endpoint, the only contract between the agents and squad
   * (ADR 0002). It lives under /api like the rest of the server surface, so the
   * rule "anything the API did not claim is the interface" keeps holding.
   */
  mcp: "/api/mcp",
} as const;

/** Where a registered project's own settings are changed. */
export function projectRoute(projectId: string): string {
  return `${apiRoutes.projects}/${projectId}`;
}

/** Where a feature's own settings are changed, go-as-recommended among them. */
export function featureRoute(featureId: string): string {
  return `${apiRoutes.features}/${featureId}`;
}

/**
 * What attaching a recorded session opens. The title is what the feature will be
 * called; left out, squad takes what the session was called, and failing that
 * the first thing that was asked of it.
 */
export const attachRecordedSessionBody = z.object({
  title: z.string().trim().min(1).optional(),
  /**
   * The same two settings an opened feature declares, for the same reason: a
   * feature born of a conversation is a feature like any other, and the screen
   * that opens one asks for both whichever door it came through.
   */
  otherProjectIds: z.array(z.string().trim().min(1)).default([]),
  goAsRecommended: z.boolean().default(false),
});
export type AttachRecordedSessionBody = z.infer<typeof attachRecordedSessionBody>;

/** Where the developer answers a question, which unblocks the agent that asked. */
export function questionAnswerRoute(questionId: string): string {
  return `${apiRoutes.questions}/${questionId}/answer`;
}

/**
 * Where one step of the walk is read. Without a path it is the home directory,
 * which is where a walk with nothing to go on starts.
 */
export function directoriesRoute(path?: string): string {
  return path === undefined
    ? apiRoutes.directories
    : `${apiRoutes.directories}?path=${encodeURIComponent(path)}`;
}

/** Where a recorded session becomes a feature squad drives. */
export function attachRecordedSessionRoute(sessionId: string): string {
  return `${apiRoutes.recordedSessions}/${sessionId}/attach`;
}

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

/** Where the developer hands back the test sheet they went through. */
export function ticketTestSheetRoute(ticketId: string): string {
  return `${apiRoutes.tickets}/${ticketId}/test-sheet`;
}

/**
 * Where the developer asks squad to go through a waiting sheet before they do.
 * The pass runs on its own after every report; this is how one is asked for on
 * a sheet reported before there was a pass, or asked for a second time.
 */
export function ticketSettlementRoute(ticketId: string): string {
  return `${apiRoutes.tickets}/${ticketId}/settlement`;
}
