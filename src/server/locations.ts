import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every path squad resolves relative to its own source, declared once. Walking
 * back up from each module that needs one leaves the depth of the walk implicit,
 * and a file moved one directory down breaks it silently.
 */
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const locations = {
  repositoryRoot,
  migrations: join(repositoryRoot, "drizzle"),
  viteConfig: join(repositoryRoot, "vite.config.ts"),
  uiBuild: join(repositoryRoot, "dist", "ui"),
  uiBuildEntry: join(repositoryRoot, "dist", "ui", "index.html"),
} as const;
