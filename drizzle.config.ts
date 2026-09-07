import { defineConfig } from "drizzle-kit";

// Migrations are generated into `drizzle/` and applied by the server at startup.
// `dbCredentials` only matters for drizzle-kit commands that touch a live
// database; generation reads the schema alone.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: "file:./drizzle/.generate.db" },
});
