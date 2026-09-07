import express, { type NextFunction, type Request, type Response } from "express";
import type { ZodType } from "zod";
import {
  apiRoutes,
  openFeatureBody,
  registerProjectBody,
  type ApiErrorBody,
  type SquadEvent,
} from "../shared/api";
import { SquadError } from "./errors";
import type { EventBus } from "./events";
import type { Store } from "./store";

export interface HttpDependencies {
  store: Store;
  bus: EventBus;
}

/**
 * The seam. Every action goes through these routes and every state change
 * leaves through the event stream, so the UI and the tests see squad through
 * exactly the same surface.
 */
export function buildApiRouter({ store, bus }: HttpDependencies): express.Router {
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
    send({ type: "snapshot", ...store.snapshot() });

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
