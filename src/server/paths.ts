import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";

/**
 * Where the database lives. Never derived from the current working directory,
 * so squad can be started from inside a repository it drives without ever
 * writing to it.
 */
export function resolveDataDir(): string {
  const explicit = process.env.SQUAD_DATA_DIR;
  if (explicit) return explicit;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "squad");
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, "squad") : join(homedir(), ".local", "share", "squad");
}

/** True when `candidate` sits inside `directory`, or is that directory itself. */
export function isInside(candidate: string, directory: string): boolean {
  const difference = relative(directory, candidate);
  return difference === "" || (!difference.startsWith("..") && !isAbsolute(difference));
}
