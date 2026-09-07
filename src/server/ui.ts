import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";

/**
 * How the browser interface is served. `dev` hands the requests to Vite in
 * middleware mode, `static` serves the build, and `none` is what the seam tests
 * use. In every mode the interface and the API share one origin, so there is no
 * dev-only proxy whose behaviour could differ from production.
 */
export type UiMode = "auto" | "dev" | "static" | "none";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const uiBuildDir = fileURLToPath(new URL("../../dist/ui", import.meta.url));

export interface MountedUi {
  close(): Promise<void>;
}

export async function mountUi(app: express.Express, mode: UiMode): Promise<MountedUi> {
  const resolved = mode === "auto" ? (process.env.NODE_ENV === "production" ? "static" : "dev") : mode;
  if (resolved === "none") return { close: async () => {} };
  if (resolved === "dev") return mountDevelopmentUi(app);
  return mountBuiltUi(app);
}

async function mountDevelopmentUi(app: express.Express): Promise<MountedUi> {
  // Imported lazily: vite is a development dependency, absent from a deployment
  // that only ever serves the build.
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: `${repositoryRoot}vite.config.ts`,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  return { close: () => vite.close() };
}

function mountBuiltUi(app: express.Express): MountedUi {
  if (!existsSync(uiBuildDir)) {
    throw new Error(`the interface has not been built yet: ${uiBuildDir} is missing, run "pnpm build"`);
  }
  app.use(express.static(uiBuildDir));
  // Single page application: any path the API did not claim renders the shell.
  app.use((request, response, next) => {
    if (request.method !== "GET" && request.method !== "HEAD") return next();
    response.sendFile(`${uiBuildDir}/index.html`);
  });
  return { close: async () => {} };
}
