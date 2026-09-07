import { existsSync } from "node:fs";
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

export async function mountUi(app: express.Express, mode: UiMode): Promise<MountedUi> {
  const resolved = mode === "auto" ? resolveFromEnvironment() : mode;
  if (resolved === "none") return { close: async () => {} };
  if (resolved === "dev") return mountDevelopmentUi(app);
  return mountBuiltUi(app);
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

function mountBuiltUi(app: express.Express): MountedUi {
  if (!existsSync(locations.uiBuild)) {
    throw new Error(
      `the interface has not been built yet: ${locations.uiBuild} is missing, run "pnpm build"`,
    );
  }
  app.use(express.static(locations.uiBuild));
  // Single page application: any path the API did not claim renders the shell.
  app.use((request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    response.sendFile(locations.uiBuildEntry);
  });
  return { close: async () => {} };
}
