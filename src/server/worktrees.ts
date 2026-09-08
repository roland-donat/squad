import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Feature, Project, Ticket, Worktree } from "../shared/api";
import type { EventBus } from "./events";
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
export class Worktrees {
  /**
   * Checkouts are made one at a time, whatever asks for them. Two tickets of
   * the same feature launched together would otherwise both find the feature
   * checkout missing and both create it, and the second `git worktree add`
   * fails on a branch already checked out. Creating one is short, and what
   * runs in parallel afterwards is the work, not the checking out.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly dataDir: string,
  ) {}

  /**
   * The ticket's checkout, created if this is its first launch and reopened if
   * its directory was cleaned off the disk. The feature's own checkout is made
   * along the way, since the ticket branch starts from the feature branch.
   */
  forTicket(ticket: Ticket): Promise<Worktree> {
    const next = this.queue.then(() => this.checkOutForTicket(ticket));
    // What the queue holds never rejects, which is what lets the line above
    // chain on it plainly: a checkout that failed is its own caller's business,
    // and must not fail the one queued behind it.
    this.queue = next.catch(() => {});
    return next;
  }

  private async checkOutForTicket(ticket: Ticket): Promise<Worktree> {
    const feature = this.store.requireFeature(ticket.featureId);
    const project = this.store.requireProject(feature.projectId);
    const startedFrom = await this.forFeature(feature, project);
    return this.checkOut(
      ticket.worktree,
      {
        branch: ticketBranch(ticket),
        path: join(this.dataDir, "worktrees", ticket.featureId, "tickets", ticket.id),
      },
      project.path,
      startedFrom.branch,
      (worktree) => this.store.recordTicketWorktree(ticket.id, worktree),
    );
  }

  /** The feature's checkout, on its own branch, started from the default one. */
  private async forFeature(feature: Feature, project: Project): Promise<Worktree> {
    return this.checkOut(
      feature.worktree,
      // Beside the ticket checkouts rather than above them: a worktree nested
      // in another shows up as untracked files in the branch it is nested in.
      {
        branch: featureBranch(feature),
        path: join(this.dataDir, "worktrees", feature.id, "feature"),
      },
      project.path,
      project.defaultBranch,
      (worktree) => {
        // Announced, not just written: a client that only listens to the event
        // stream holds the whole state, which is what the snapshot promises.
        this.bus.publish({
          type: "feature-changed",
          feature: this.store.recordFeatureWorktree(feature.id, worktree),
        });
      },
    );
  }

  /**
   * Checks a branch out, and writes down where. What was recorded on an earlier
   * launch wins over what squad would name today, so a title changed since then
   * cannot strand the checkout that holds the work.
   */
  private async checkOut(
    recorded: Worktree | null,
    intended: Worktree,
    repositoryRoot: string,
    startPoint: string,
    record: (worktree: Worktree) => void,
  ): Promise<Worktree> {
    const worktree = recorded ?? intended;
    if (!(await exists(worktree.path))) {
      await createWorktree({ repositoryRoot, startPoint, ...worktree });
    }
    if (recorded === null) record(worktree);
    return worktree;
  }
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
