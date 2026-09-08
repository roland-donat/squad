import express, { type NextFunction, type Request, type Response } from "express";
import type { ZodType } from "zod";
import {
  answerQuestionBody,
  apiRoutes,
  launchTicketBody,
  openFeatureBody,
  registerProjectBody,
  reviewTestSheetBody,
  sendMainSessionMessageBody,
  startMainSessionBody,
  updateFeatureBody,
  updateProjectBody,
  updateSettingsBody,
  type ApiErrorBody,
  type SquadEvent,
} from "../shared/api";
import type { Autonomy } from "./autonomy";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import { buildMcpHandler } from "./mcp";
import type { Questions } from "./questions";
import type { MainSessions } from "./sessions";
import type { Store } from "./store";
import type { Merges } from "./merges";
import type { SubSessions } from "./sub-sessions";
import type { Validations } from "./validations";

export interface HttpDependencies {
  store: Store;
  bus: EventBus;
  mainSessions: MainSessions;
  subSessions: SubSessions;
  validations: Validations;
  merges: Merges;
  questions: Questions;
  autonomy: Autonomy;
}

/**
 * The seam. Every action goes through these routes and every state change
 * leaves through the event stream, so the UI and the tests see squad through
 * exactly the same surface.
 */
export function buildApiRouter({
  store,
  bus,
  mainSessions,
  subSessions,
  validations,
  merges,
  questions,
  autonomy,
}: HttpDependencies): express.Router {
  const router = express.Router();
  router.use(express.json());

  router.get(apiRoutes.projects, (_request, response) => {
    response.json({ projects: store.listProjects() });
  });

  router.post(apiRoutes.projects, async (request, response) => {
    const body = parse(registerProjectBody, request.body);
    const project = await store.registerProject(body);
    bus.publish({ type: "project-registered", project });
    response.status(201).json({ project });
  });

  router.put(`${apiRoutes.projects}/:projectId`, async (request, response) => {
    const body = parse(updateProjectBody, request.body);
    const project = await store.updateProject(request.params.projectId, body);
    bus.publish({ type: "project-changed", project });
    // A cap raised is a place freed: whatever was waiting on it starts now,
    // rather than at the next thing that happens to move.
    subSessions.schedule();
    response.json({ project });
  });

  router.get(apiRoutes.features, (request, response) => {
    const projectId = request.query["projectId"];
    if (projectId !== undefined && typeof projectId !== "string") {
      throw new SquadError("invalid_request", 400, "projectId must be a single value");
    }
    response.json({ features: store.listFeatures(projectId) });
  });

  router.post(apiRoutes.features, (request, response) => {
    const body = parse(openFeatureBody, request.body);
    const feature = store.openFeature(body);
    bus.publish({ type: "feature-opened", feature });
    response.status(201).json({ feature });
  });

  router.put(`${apiRoutes.features}/:featureId`, (request, response) => {
    const body = parse(updateFeatureBody, request.body);
    const featureId = request.params.featureId;
    if (body.projectIds !== undefined) store.setCarriedRepositories(featureId, body.projectIds);
    if (body.goAsRecommended !== undefined) {
      // Through the mode rather than through the store: arming a feature is
      // also what starts it moving, what clears whatever stopped it last time,
      // and what announces it. Left out, the mode is left exactly as it stands.
      response.json({ feature: autonomy.arm(featureId, body.goAsRecommended) });
      return;
    }
    // Announced here instead, since nothing else did: what a feature carries is
    // part of the state a client holding only the event stream is promised.
    const feature = store.requireFeature(featureId);
    bus.publish({ type: "feature-changed", feature });
    response.json({ feature });
  });

  router.get(`${apiRoutes.features}/:featureId/graph`, (request, response) => {
    response.json(store.featureGraph(request.params.featureId));
  });

  router.post(`${apiRoutes.features}/:featureId/main-session`, async (request, response) => {
    const body = parse(startMainSessionBody, request.body);
    const session = await mainSessions.start(request.params.featureId, body.prompt);
    // Accepted, not done: the session runs for as long as its agent does, and
    // what it produces arrives on the event stream.
    response.status(202).json({ sessionId: session.id });
  });

  router.post(
    `${apiRoutes.features}/:featureId/main-session/messages`,
    async (request, response) => {
      const body = parse(sendMainSessionMessageBody, request.body);
      await mainSessions.send(request.params.featureId, body.text);
      // The answer is not part of this response: it arrives on the event stream,
      // line by line, for as long as the session keeps writing.
      response.status(202).json({});
    },
  );

  router.post(`${apiRoutes.tickets}/:ticketId/session`, (request, response) => {
    const body = parse(launchTicketBody, request.body);
    const ticket = subSessions.launch(request.params.ticketId, body.angle);
    // Accepted, not done: the launch waits for a place under the concurrency
    // caps, its sub-session runs for as long as its agent does, and everything
    // that happens next arrives on the event stream.
    response.status(202).json({ ticket });
  });

  router.post(`${apiRoutes.tickets}/:ticketId/test-sheet`, async (request, response) => {
    const body = parse(reviewTestSheetBody, request.body);
    const reviewed = store.reviewTestSheet({ ticketId: request.params.ticketId, ...body });
    bus.publish({ type: "graph-changed", graph: store.featureGraph(reviewed.featureId) });
    // Awaited, so what the answer carries is the ticket as the review left it:
    // a correction handed back puts the step in progress again, and a client
    // reading the answer would otherwise see the state it had a moment before.
    await validations.afterReview(reviewed);
    response.json({ ticket: store.requireTicket(reviewed.id) });
  });

  router.post(`${apiRoutes.questions}/:questionId/answer`, (request, response) => {
    const body = parse(answerQuestionBody, request.body);
    // The agent waiting on this question is released by this very call: what it
    // asked for comes back to it as the result of its own tool call.
    const question = questions.answer(request.params.questionId, body.answer);
    response.json({ question });
  });

  router.get(apiRoutes.settings, (_request, response) => {
    response.json({ settings: store.settings() });
  });

  router.put(apiRoutes.settings, (request, response) => {
    const body = parse(updateSettingsBody, request.body);
    const settings = store.updateSettings(body);
    bus.publish({ type: "settings-changed", settings });
    // The machine-wide cap lives here, so raising it frees a place just as an
    // ending sub-session does.
    subSessions.schedule();
    response.json({ settings });
  });

  // Squad's own MCP endpoint: the surface the agents talk to, on the very port
  // that serves the interface, so a session has one address for all of squad.
  router.all(
    apiRoutes.mcp,
    buildMcpHandler({ store, bus, questions, autonomy, validations, subSessions, merges }),
  );

  router.get(apiRoutes.events, (request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Squad is served behind no proxy of its own, but a user may put one in
      // front of it; this keeps such a proxy from buffering the stream.
      "x-accel-buffering": "no",
    });

    const send = (event: SquadEvent) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: "snapshot", ...store.storedState(), mainSessions: mainSessions.list() });

    const unsubscribe = bus.subscribe(send);
    // A comment frame keeps the connection alive through idle periods without
    // reaching the client's event handlers.
    const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
    heartbeat.unref();

    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Anything under /api that no route claimed is an API request, and must be
  // answered as one: letting it fall through would hand the interface's own
  // shell to a caller expecting JSON.
  router.use("/api", (request) => {
    throw new SquadError("not_found", 404, `no API route for ${request.method} ${request.originalUrl}`);
  });

  router.use(renderError);
  return router;
}

function parse<T>(schema: ZodType<T>, payload: unknown): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new SquadError("invalid_request", 400, detail);
  }
  return result.data;
}

function renderError(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof SquadError) {
    const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
    response.status(error.status).json(body);
    return;
  }
  console.error("unexpected failure while handling a request", error);
  const body: ApiErrorBody = {
    error: { code: "internal_error", message: "unexpected failure" },
  };
  response.status(500).json(body);
}
