import { afterEach, describe, expect, it } from "vitest";
import type { FeatureGraph, Question, ThreadEntry, Ticket } from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  mainSessionRoute,
  questionAnswerRoute,
  ticketSessionRoute,
} from "../../src/shared/api";
import { pendingActions } from "../../src/shared/pending";
import { connectToSquadTools } from "../support/mcp";
import { createScriptedLauncher, type ScriptedAgent } from "../support/scripted-launcher";
import {
  openTestFeature,
  startTestSquad,
  waitForEvent,
  type EventStream,
  type TestSquad,
} from "../support/squad";
import { startWebhookReceiver, type WebhookReceiver } from "../support/webhook";

/**
 * A question an agent asks, and the wait that follows. The call an agent makes
 * to ask does not return until the question is answered, which is what makes
 * the interface the place questions are settled rather than a terminal nobody
 * is watching. Everything here goes through the surface the interface and the
 * agents use: the tool over MCP, the answer over HTTP, the alert over a real
 * webhook.
 */
describe("a question asked from a session, and the wait it opens", () => {
  let squad: TestSquad;
  let webhook: WebhookReceiver | null = null;
  const gates: Gate[] = [];

  afterEach(async () => {
    for (const gate of gates) gate.open();
    gates.length = 0;
    await squad.dispose();
    await webhook?.close();
    webhook = null;
  });

  /** A session that stays where it is until the test lets it go. */
  interface Gate {
    passed: Promise<void>;
    open(): void;
  }

  function gate(): Gate {
    let release = () => {};
    const passed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const created = { passed, open: () => release() };
    gates.push(created);
    return created;
  }

  /**
   * One scripted launcher for both roles: the main session writes the ticket
   * every scenario starts from and then runs the script handed in, and every
   * sub-session runs the other one.
   */
  async function start(options: {
    mainSession?: (agent: ScriptedAgent) => Promise<void>;
    subSession?: (agent: ScriptedAgent) => Promise<void>;
  }): Promise<{ featureId: string; stream: EventStream; ticket: Ticket }> {
    squad = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        if (agent.request.role === "main") {
          await agent.awaitMessage();
          await agent.call("create_ticket", {
            featureId: agent.request.featureId,
            kind: "build",
            title: "Le store",
            description: "La base et ses migrations.",
            acceptanceCriteria: ["La base s'ouvre"],
          });
          await options.mainSession?.(agent);
          return;
        }
        await options.subSession?.(agent);
      }),
    });
    const { feature } = await openTestFeature(squad, "Le noyau");
    const stream = await squad.openEventStream();
    expect((await stream.next()).type).toBe("snapshot");
    await squad.request("POST", mainSessionRoute(feature.id), { prompt: "/to-tickets" });
    await waitForEvent(stream, "graph-changed");
    return { featureId: feature.id, stream, ticket: await readTicket(feature.id) };
  }

  /** Sends squad's alerts to an endpoint this test can read. */
  async function catchAlerts(): Promise<WebhookReceiver> {
    const receiver = await startWebhookReceiver();
    webhook = receiver;
    const answer = await squad.request("PUT", apiRoutes.settings, { webhookUrl: receiver.url });
    expect(answer.status).toBe(200);
    return receiver;
  }

  async function readGraph(featureId: string): Promise<FeatureGraph> {
    const response = await squad.request("GET", featureGraphRoute(featureId));
    return (await response.json()) as FeatureGraph;
  }

  async function readTicket(featureId: string): Promise<Ticket> {
    const ticket = (await readGraph(featureId)).tickets.find((each) => each.title === "Le store");
    if (!ticket) throw new Error("the ticket the main session wrote is missing from the graph");
    return ticket;
  }

  /** Everything a fresh connection is handed: threads and questions alike. */
  async function readSnapshot(): Promise<{ threads: ThreadEntry[]; questions: Question[] }> {
    const stream = await squad.openEventStream();
    const snapshot = await stream.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is always a snapshot");
    return { threads: snapshot.threads, questions: snapshot.questions };
  }

  /** Waits for the next question the stream carries in a given state. */
  async function waitForQuestion(
    stream: EventStream,
    state: Question["state"],
  ): Promise<Question> {
    for (;;) {
      const event = await waitForEvent(stream, "question-changed");
      if (event.question.state === state) return event.question;
    }
  }

  it("holds the call open until the developer answers, and hands the answer back", async () => {
    const alive = gate();
    const asking = { answer: null as Question | null };
    let returned = () => {};
    const answered = new Promise<void>((resolve) => {
      returned = resolve;
    });

    const { featureId, stream, ticket } = await start({
      subSession: async (agent) => {
        await agent.awaitMessage();
        asking.answer = (await agent.call("ask_question", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          question: "Quel format pour les identifiants de ticket ?",
          options: ["UUID v4", "un entier croissant"],
          recommendation: "UUID v4",
          scopeChanging: false,
        })) as Question;
        returned();
        await alive.passed;
      },
    });
    const receiver = await catchAlerts();

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    const asked = await waitForQuestion(stream, "pending");

    // What the agent offered, on the ticket it is building, and nothing decided.
    expect(asked.ticketId).toBe(ticket.id);
    expect(asked.options).toEqual(["UUID v4", "un entier croissant"]);
    expect(asked.recommendation).toBe("UUID v4");
    expect(asked.scopeChanging).toBe(false);
    expect(asked.answer).toBeNull();
    // The call has not come back: the agent is waiting, not carrying on.
    expect(asking.answer).toBeNull();

    // The developer is told wherever they are, and the indicator lists it.
    const alert = await receiver.next();
    expect(alert.text).toContain("Quel format pour les identifiants");
    expect(pendingActions([await readGraph(featureId)], [asked])).toEqual([
      {
        featureId,
        ticketId: ticket.id,
        title: "Quel format pour les identifiants de ticket ?",
        reason: "question",
      },
    ]);

    const given = await squad.request("POST", questionAnswerRoute(asked.id), {
      answer: "UUID v4, comme partout ailleurs.",
    });
    expect(given.status).toBe(200);

    // The very call the agent made is what carries the answer back to it.
    await answered;
    expect(asking.answer?.state).toBe("answered");
    expect(asking.answer?.answer).toBe("UUID v4, comme partout ailleurs.");
    expect(asking.answer?.answeredBy).toBe("developer");

    // And what was asked and what was answered are both readable on the ticket.
    const { threads, questions } = await readSnapshot();
    const said = threads
      .filter((entry) => entry.ticketId === ticket.id && entry.kind === "notice")
      .map((entry) => entry.text);
    expect(said).toContain("the session asked a question");
    expect(said).toContain("the developer answered the question");
    expect(questions.map((question) => question.state)).toEqual(["answered"]);
    // Nothing waits on the developer any more.
    expect(pendingActions([await readGraph(featureId)], questions)).toEqual([]);
  });

  it("refuses a recommendation that is not one of the options offered", async () => {
    const refusal = { text: "" };
    const { featureId, stream, ticket } = await start({
      subSession: async (agent) => {
        await agent.awaitMessage();
        const outcome = await agent.attempt("ask_question", {
          featureId: agent.request.featureId,
          ticketId: agent.request.ticketId,
          question: "Quelle base ?",
          options: ["SQLite", "Postgres"],
          recommendation: "DuckDB",
          scopeChanging: false,
        });
        expect(outcome.refused).toBe(true);
        refusal.text = outcome.text;
      },
    });

    await squad.request("POST", ticketSessionRoute(ticket.id), {});
    // The session ends of its own accord once the refusal comes back, and the
    // ticket stops with it: nothing was asked, so nothing waits.
    await expect
      .poll(async () => (await readTicket(featureId)).state, { timeout: 10_000 })
      .toBe("failed");
    expect(refusal.text).toContain("DuckDB");
    expect((await readSnapshot()).questions).toEqual([]);
    // Read to keep the stream drained for the disposal that follows.
    expect(stream).toBeDefined();
  });

  it("refuses a question about a ticket no session ever ran", async () => {
    const { featureId } = await start({});
    const ticket = await readTicket(featureId);
    const tools = await connectToSquadTools(squad.url);
    try {
      const outcome = await tools.attempt("ask_question", {
        featureId,
        ticketId: ticket.id,
        question: "Faut-il continuer ?",
        options: ["oui", "non"],
        recommendation: "oui",
        scopeChanging: false,
      });
      expect(outcome.refused).toBe(true);
      expect(outcome.text).toContain("Le store");
    } finally {
      await tools.close();
    }
  });

  it("abandons a question its session cannot come back to, and says so", async () => {
    const { featureId, stream } = await start({
      mainSession: async (agent) => {
        await agent.attempt("ask_question", {
          featureId: agent.request.featureId,
          question: "Faut-il découper la fondation en deux ?",
          options: ["oui", "non"],
          recommendation: "non",
          scopeChanging: true,
        });
      },
    });

    // Asked from the main session, so it hangs on the feature and on no ticket.
    const asked = await waitForQuestion(stream, "pending");
    expect(asked.ticketId).toBeNull();
    expect(asked.featureId).toBe(featureId);

    // Squad goes down while it waits: the session that asked cannot survive it,
    // so an answer given afterwards would reach nobody.
    await squad.restart();

    const { threads, questions } = await readSnapshot();
    expect(questions.map((question) => question.state)).toEqual(["abandoned"]);
    expect(
      threads.filter((entry) => entry.ticketId === null).map((entry) => entry.text),
    ).toContain("the question was abandoned");
    // It is not waiting on the developer any more: there is nobody to answer to.
    expect(pendingActions([await readGraph(featureId)], questions)).toEqual([]);

    const late = await squad.request("POST", questionAnswerRoute(asked.id), { answer: "oui" });
    expect(late.status).toBe(409);
  });
});
