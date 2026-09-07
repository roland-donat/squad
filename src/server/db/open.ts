import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { locations } from "../locations";
import * as schema from "./schema";

export type SquadDatabase = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  db: SquadDatabase;
  close(): void;
}

/**
 * Opens the database under `dataDir`, creating it if needed, and brings it up
 * to the latest migration. Foreign keys are enforced, which SQLite leaves off
 * by default.
 */
export async function openDatabase(dataDir: string): Promise<OpenedDatabase> {
  await mkdir(dataDir, { recursive: true });
  const connection = new Database(join(dataDir, "squad.db"));
  connection.pragma("journal_mode = WAL");
  migrateWithForeignKeysOff(connection);
  connection.pragma("foreign_keys = ON");
  return { db: drizzle(connection, { schema }), close: () => connection.close() };
}

/**
 * Brings the database up to date, and it is the pragma that matters here.
 *
 * SQLite cannot alter a constraint in place, so changing one makes drizzle
 * generate the twelve-step rebuild: copy the table aside, drop the original,
 * rename the copy back. That `DROP` fires every `ON DELETE cascade` pointing at
 * the table, so rebuilding `tickets` deletes its acceptance criteria and its
 * blocking edges. `PRAGMA foreign_keys` is silently ignored inside a
 * transaction, which is where drizzle runs migrations, so the `foreign_keys=OFF`
 * written at the top of the generated file does nothing at all: measured on a
 * real database, one added lifecycle value took ten criteria and two edges to
 * zero without a word.
 *
 * Turning it off out here, before the transaction opens, is what the SQLite
 * procedure actually asks for. `foreign_key_check` afterwards is the safety net:
 * enforcement was off, so a migration that did leave a dangling reference has to
 * be caught rather than committed and enforced later against rows nobody can fix.
 */
function migrateWithForeignKeysOff(connection: Database.Database): void {
  connection.pragma("foreign_keys = OFF");
  migrate(drizzle(connection, { schema }), { migrationsFolder: locations.migrations });
  const dangling = connection.pragma("foreign_key_check") as unknown[];
  if (dangling.length > 0) {
    throw new Error(
      `a migration left ${dangling.length} row(s) pointing at something that is gone: ${JSON.stringify(dangling)}`,
    );
  }
}
