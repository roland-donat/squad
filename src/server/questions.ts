import type { AnswerSource, Question } from "../shared/api";
import { alertFor, type Alerts } from "./alerts";
import type { QuestionVerdict } from "./autonomy";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { QuestionOptionInput, Store } from "./store";
import { appendToThread, type ThreadLine } from "./threads";

/**
 * The questions agents ask, and the wait that follows. A tool call that asks one
 * does not return until the question is answered, which is what makes the
 * interface the place a question is settled (ADR 0002): no polling, no second
 * mechanism, and no terminal to go back to.
 *
 * Squad answers none of them itself except in go-as-recommended, and then only
 * with the agent's own recommendation. One that changes what is built is
 * answered like the rest and raises an alert saying squad answered it
 * (ADR 0012). Everything else waits for the developer, however long that takes.
 */

/** What an agent hands over when it asks. The session it asks from is squad's to know. */
export interface AskInput {
  featureId: string;
  /** The ticket whose sub-session is asking, or null for the main session. */
  ticketId: string | null;
  prompt: string;
  options: QuestionOptionInput[];
  recommendation: string;
  scopeChanging: boolean;
}

export interface QuestionDependencies {
  store: Store;
  bus: EventBus;
  alerts: Alerts;
  /**
   * What the mode does with a question, declared by what is needed of it: on a
   * driven feature it answers with the agent's own recommendation, and says so
   * with an alert when the answer changes what is built.
   */
  autonomy: { verdictFor(question: Question): QuestionVerdict };
  /**
   * Which session is holding a feature's main thread, for a question asked
   * outside any ticket. Declared by what is needed of it rather than by who
   * provides it.
   */
  mainSessions: { sessionIdOf(featureId: string): string | null };
}

export class Questions {
  // The tool calls waiting on an answer, one per pending question. Held in
  // memory on purpose: a wait cannot outlive the process that is waiting, and a
  // restart marks what was pending abandoned rather than pretending otherwise.
  private readonly waiting = new Map<string, (question: Question) => void>();

  constructor(private readonly dependencies: QuestionDependencies) {}

  /**
   * Writes the question, then answers it or waits for it. The answer comes back
   * to the caller, which is the agent's tool call: it reads what was decided as
   * the result of the very call it made, without having to ask again.
   */
  async ask(input: AskInput): Promise<Question> {
    const { store, alerts, autonomy } = this.dependencies;
    const question = store.askQuestion({ ...input, sessionId: this.sessionFor(input) });
    this.announce(question);
    this.note(question, {
      kind: "notice",
      text: "the session asked a question",
      detail: statementOf(question),
    });

    const verdict = autonomy.verdictFor(question);
    if (verdict.kind === "answer") return this.settle(question.id, verdict.answer, "squad");
    alerts.raise(alertFor.questionWaiting(question));
    return new Promise<Question>((resolve) => this.waiting.set(question.id, resolve));
  }

  /** The developer's answer, which is what releases the agent that asked. */
  answer(questionId: string, answer: string): Question {
    return this.settle(questionId, answer, "developer");
  }

  /**
   * Answers every question a feature left open that squad may answer alone.
   *
   * A question is answered once, when it is asked, and a feature held at that
   * moment gets "wait": nothing ever asks again, so an implementation question
   * squad had every right to answer sits in front of the developer until they
   * answer it themselves. It is the same defect the arbitrations of a test
   * sheet had, and it is the same remedy, because lifting the hold is what asks
   * again. Measured on the instance: the only session still running was held on
   * a question squad could have answered.
   *
   * Perimeter questions are read like the rest. They used to be skipped, on
   * the grounds that reading one stopped the mode and it had already stopped
   * when the question was asked; nothing stops any more. Skipping them now
   * would leave the sub-session that asked blocked for ever, on a feature the
   * screen shows as driving: arming the mode would be the dead button this
   * exists to prevent (ADR 0012).
   */
  takeOpen(featureId: string): void {
    const { store, autonomy } = this.dependencies;
    for (const question of store.listQuestions(featureId)) {
      if (question.state !== "pending") continue;
      const verdict = autonomy.verdictFor(question);
      if (verdict.kind !== "answer") continue;
      this.settle(question.id, verdict.answer, "squad");
    }
  }

  /**
   * Lets go of every question still waiting, so a shutdown does not leave a tool
   * call pending on an answer that will never come. Nothing is written: the row
   * stays pending, and the next start abandons it like any other, which is also
   * what happens when squad did not get the chance to stop cleanly.
   */
  releaseAll(): void {
    for (const [questionId, resolve] of this.waiting) {
      resolve(this.dependencies.store.requireQuestion(questionId));
    }
    this.waiting.clear();
  }

  /**
   * Settles the questions of a run that is over. Their sessions cannot outlive
   * the server that opened them, so a question still pending at startup is one
   * whose answer would reach nobody: it is closed and said so, rather than left
   * in front of a developer whose answer would go nowhere.
   */
  abandonInterrupted(): void {
    this.abandon(
      this.dependencies.store.abandonPendingQuestions(),
      "squad stopped while this question was waiting for an answer",
    );
  }

  /**
   * Settles what a session that has just ended was waiting on. Same reason: an
   * answer given to a session that is over reaches nobody, and a question that
   * stays in the indicator asks the developer for something no agent will hear.
   */
  abandonFor(sessionId: string): void {
    this.abandon(
      this.dependencies.store.abandonQuestionsOfSession(sessionId),
      "the session that asked it ended before it was answered",
    );
  }

  private abandon(abandoned: readonly Question[], why: string): void {
    for (const question of abandoned) {
      this.announce(question);
      this.note(question, { kind: "notice", text: "the question was abandoned", detail: why });
      // The waiter, if squad is still holding one: a call left pending would
      // keep a promise alive for an answer that is never coming.
      const waiter = this.waiting.get(question.id);
      this.waiting.delete(question.id);
      waiter?.(question);
    }
  }

  private settle(questionId: string, answer: string, answeredBy: AnswerSource): Question {
    const { store } = this.dependencies;
    const settled = store.answerQuestion(questionId, answer, answeredBy);
    this.announce(settled);
    this.note(settled, {
      kind: "notice",
      text:
        answeredBy === "squad"
          ? "squad answered with the agent's own recommendation"
          : "the developer answered the question",
      detail: `${settled.prompt}\n\n${answer}`,
    });
    const waiter = this.waiting.get(questionId);
    this.waiting.delete(questionId);
    waiter?.(settled);
    return settled;
  }

  /**
   * Which session a question is written on. Read from what squad recorded
   * rather than taken from the caller: a session that is not the one squad
   * opened on this ticket has no thread of its own to be answered on.
   */
  private sessionFor(input: AskInput): string {
    const { store, mainSessions } = this.dependencies;
    if (input.ticketId === null) {
      const sessionId = mainSessions.sessionIdOf(input.featureId);
      if (sessionId === null) {
        throw new SquadError(
          "main_session_not_running",
          409,
          `the main session of feature ${input.featureId} is not running: a question is asked from a session squad opened`,
        );
      }
      return sessionId;
    }
    const ticket = store.requireTicket(input.ticketId);
    if (ticket.sessionId === null) {
      throw new SquadError(
        "no_step_in_progress",
        409,
        `no sub-session ever ran on ticket "${ticket.title}": a question is asked from a session squad opened`,
      );
    }
    return ticket.sessionId;
  }

  private announce(question: Question): void {
    this.dependencies.bus.publish({ type: "question-changed", question });
  }

  private note(question: Question, line: ThreadLine): void {
    const { store, bus } = this.dependencies;
    appendToThread(
      store,
      bus,
      {
        featureId: question.featureId,
        ticketId: question.ticketId,
        sessionId: question.sessionId,
      },
      line,
    );
  }
}

/** A question as its thread reads it: what was asked, and what was on offer. */
function statementOf(question: Question): string {
  return [
    question.prompt,
    "",
    // The label and what it costs, on the thread as on the screen: a reader of
    // the thread alone has to be able to tell what was on the table.
    ...question.options.map((option) =>
      [
        `- ${option.label}${option.label === question.recommendation ? " (recommended)" : ""}`,
        option.consequence === null ? null : `  ${option.consequence}`,
        option.illustration === null ? null : `  ${option.illustration}`,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    ),
    "",
    question.scopeChanging
      ? "It changes what is built: under go-as-recommended squad answers it with the recommendation and wakes the developer to say so."
      : "It changes only how it is built.",
  ].join("\n");
}
