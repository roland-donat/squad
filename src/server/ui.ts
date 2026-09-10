import { existsSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { locations } from "./locations";

/**
 * How the browser interface is served. `dev` hands the requests to Vite in
 * middleware mode, `static` serves the build, and `none` is what the seam tests
 * use. In every mode the interface and the API share one origin, so there is no
 * dev-only proxy whose behaviour could differ from production.
 */
export type UiMode = "auto" | "dev" | "static" | "none";

export interface MountedUi {
  close(): Promise<void>;
}

export async function mountUi(
  app: express.Express,
  mode: UiMode,
  /**
   * Where the build is read from. Declared rather than always taken from
   * squad's own source tree, so that a test can serve a build it wrote itself,
   * at a path of its choosing.
   */
  buildDir: string = locations.uiBuild,
): Promise<MountedUi> {
  const resolved = mode === "auto" ? resolveFromEnvironment() : mode;
  if (resolved === "none") return { close: async () => {} };
  if (resolved === "dev") return mountDevelopmentUi(app);
  return mountBuiltUi(app, buildDir);
}

function resolveFromEnvironment(): "dev" | "static" {
  return process.env.NODE_ENV === "production" ? "static" : "dev";
}

async function mountDevelopmentUi(app: express.Express): Promise<MountedUi> {
  // Imported lazily: vite is a development dependency, absent from a deployment
  // that only ever serves the build.
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: locations.viteConfig,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  return { close: () => vite.close() };
}

function mountBuiltUi(app: express.Express, buildDir: string): MountedUi {
  const shell = join(buildDir, "index.html");
  // The shell itself, not the directory around it: without it every path but
  // the API answers 404, and a missing build must be said at boot rather than
  // once per request.
  if (!existsSync(shell)) {
    throw new Error(`the interface has not been built yet: ${shell} is missing, run "pnpm build"`);
  }
  app.use(express.static(buildDir));
  // Single page application: any path the API did not claim renders the shell.
  app.use((request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    // Named relative to the build directory, never by its absolute path: what
    // serves a file refuses any path holding a dot segment, and squad is
    // installed under ~/.local/lib/squad. Handed the absolute path, it answers
    // 404 to every route of the interface and 200 to the API alone.
    response.sendFile("index.html", { root: buildDir });
  });
  return { close: async () => {} };
}
