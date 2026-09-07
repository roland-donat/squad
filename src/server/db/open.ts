import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type SquadDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  db: SquadDatabase;
  close(): void;
}

const migrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

/**
 * Opens the database under `dataDir`, creating it if needed, and brings it up
 * to the latest migration. Foreign keys are enforced, which SQLite leaves off
 * by default.
 */
export async function openDatabase(dataDir: string): Promise<OpenedDatabase> {
  await mkdir(dataDir, { recursive: true });
  const connection = new Database(join(dataDir, "squad.db"));
  connection.pragma("journal_mode = WAL");
  connection.pragma("foreign_keys = ON");
  const db = drizzle(connection, { schema });
  migrate(db, { migrationsFolder });
  return { db, close: () => connection.close() };
}
