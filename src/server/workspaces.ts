import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Feature, Ticket } from "../shared/api";
import { createWorktree } from "./git";
import type { Store } from "./store";

/**
 * Where squad checks out the branches it drives. Two stages, as ADR 0003 lays
 * them out: a feature branch, which is where ticket branches will come back
 * together, and one branch per ticket started from it.
 *
 * Every checkout lives under squad's own data directory, never inside the
 * repository being driven and never beside it. The repository therefore keeps
 * exactly the shape its owner left it in, and squad's own files are all in one
 * place to look at and to clean up.
 *
 * Branch names and paths are stored on the row the first time they are used
 * rather than recomputed from the title at each call: a feature renamed
 * tomorrow must still find the worktree it opened today.
 */
export class Workspaces {
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}

  /**
   * The ticket's worktree, created if this is its first launch and reopened if
   * its directory was cleaned off the disk. The feature's own worktree is
   * created along the way, since the ticket branch starts from its branch.
   */
  async forTicket(ticket: Ticket): Promise<Workspace> {
    const feature = await this.forFeature(ticket.featureId);
    const project = this.store.requireProject(feature.feature.projectId);
    const branch = ticket.branch ?? ticketBranch(ticket);
    const path = ticket.worktreePath ?? this.ticketPath(ticket);

    if (!(await exists(path))) {
      await createWorktree({
        repositoryRoot: project.path,
        path,
        branch,
        startPoint: feature.branch,
      });
    }
    if (ticket.branch !== branch || ticket.worktreePath !== path) {
      this.store.recordTicketWorkspace(ticket.id, branch, path);
    }
    return { branch, path };
  }

  /** The feature's worktree, on its own branch, started from the default branch. */
  private async forFeature(featureId: string): Promise<Workspace & { feature: Feature }> {
    const feature = this.store.requireFeature(featureId);
    const project = this.store.requireProject(feature.projectId);
    const branch = feature.branch ?? featureBranch(feature);
    const path = feature.worktreePath ?? this.featurePath(feature);

    if (!(await exists(path))) {
      await createWorktree({
        repositoryRoot: project.path,
        path,
        branch,
        startPoint: project.defaultBranch,
      });
    }
    if (feature.branch !== branch || feature.worktreePath !== path) {
      this.store.recordFeatureWorkspace(feature.id, branch, path);
    }
    return { branch, path, feature };
  }

  private featurePath(feature: Feature): string {
    return join(this.dataDir, "worktrees", feature.id, "feature");
  }

  /**
   * Beside the feature's checkout rather than inside it: a worktree nested in
   * another would show up as untracked files in the branch it is nested in.
   */
  private ticketPath(ticket: Ticket): string {
    return join(this.dataDir, "worktrees", ticket.featureId, "tickets", ticket.id);
  }
}

export interface Workspace {
  branch: string;
  path: string;
}

/**
 * Two flat namespaces rather than one nesting the other: git stores branches as
 * files, so a branch `squad/feature/x` and a branch `squad/feature/x/y` cannot
 * both exist. Keeping features and tickets apart makes that collision
 * impossible whatever the titles are.
 */
function featureBranch(feature: Feature): string {
  return `squad/feature/${slug(feature.title)}-${short(feature.id)}`;
}

function ticketBranch(ticket: Ticket): string {
  return `squad/ticket/${slug(ticket.title)}-${short(ticket.id)}`;
}

/** Enough of an id to tell two branches apart, and short enough to read. */
function short(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

/**
 * A title turned into something git accepts as part of a ref: accents dropped,
 * anything else that is not a letter or a digit turned into a single dash. The
 * id appended by the callers is what makes the result unique, so this only has
 * to stay readable.
 */
function slug(title: string): string {
  const plain = title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return plain === "" ? "sans-titre" : plain;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
