import { rename, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Feature, Project, Ticket, Worktree } from "../shared/api";
import type { EventBus } from "./events";
import { SquadError } from "./errors";
import { branchExists, createWorktree, isCheckout } from "./git";
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
    return this.enqueue(() => this.checkOutForTicket(ticket));
  }

  /**
   * The feature's checkout in one of its repositories, created if this is the
   * first time anything of that repository is checked out and reopened if its
   * directory was cleaned off the disk. Asked for on its own when a ticket
   * branch comes back into it: the merge happens there, and a repository whose
   * worktree was cleaned up would otherwise have nowhere to merge into.
   */
  forFeature(feature: Feature, project: Project): Promise<Worktree> {
    return this.enqueue(() => this.checkOutForFeature(feature, project));
  }

  private enqueue(checkOut: () => Promise<Worktree>): Promise<Worktree> {
    const next = this.queue.then(checkOut);
    // What the queue holds never rejects, which is what lets the line above
    // chain on it plainly: a checkout that failed is its own caller's business,
    // and must not fail the one queued behind it.
    this.queue = next.catch(() => {});
    return next;
  }

  private async checkOutForTicket(ticket: Ticket): Promise<Worktree> {
    const feature = this.store.requireFeature(ticket.featureId);
    // The ticket's own repository, not the feature's home one: a feature
    // carries several, and this is where this ticket is built.
    const project = this.store.requireProject(ticket.projectId);
    const startedFrom = await this.checkOutForFeature(feature, project);
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

  /**
   * The feature's checkout in one repository, on its own branch, started from
   * that repository's default branch. One per repository the feature carries,
   * each under a directory of its own: two repositories checked out at the same
   * path would be the same directory holding two working trees.
   */
  private async checkOutForFeature(feature: Feature, project: Project): Promise<Worktree> {
    const carried = this.store.requireFeatureRepository(feature.id, project.id);
    return this.checkOut(
      carried.worktree,
      // Beside the ticket checkouts rather than above them: a worktree nested
      // in another shows up as untracked files in the branch it is nested in.
      {
        branch: featureBranch(feature),
        path: join(this.dataDir, "worktrees", feature.id, "repositories", project.id, "feature"),
      },
      project.path,
      project.defaultBranch,
      (worktree) => {
        // Announced, not just written: a client that only listens to the event
        // stream holds the whole state, which is what the snapshot promises.
        this.bus.publish({
          type: "feature-changed",
          feature: this.store.recordFeatureWorktree(feature.id, project.id, worktree),
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
    // Usable, not merely there. A directory git no longer knows as a checkout
    // is worse than a missing one: every command run in it fails, and the
    // failure names the repository rather than what was being done, so squad
    // retries a merge that cannot ever work.
    if (!(await usable(worktree.path))) {
      // A checkout squad recorded and no longer finds is one it may rebuild,
      // but only from the branch that holds the work. If that branch is gone
      // too, the repository this ticket was built in is not the one in front of
      // us: a fresh branch off the default one would look like a resumed ticket
      // and be an empty one. The case is not theoretical: the data directory
      // travels between machines while the checkouts, build output and all, do
      // not.
      if (recorded !== null && !(await branchExists(repositoryRoot, recorded.branch))) {
        throw new SquadError(
          "branch_not_found",
          409,
          `squad recorded the branch ${recorded.branch} for this checkout and ${repositoryRoot} does not have it: the work it holds is not in this repository, and squad will not open an empty branch in its place`,
        );
      }
      // A directory still there is set aside rather than written over: what it
      // holds cannot be read any more, so squad cannot tell build output from a
      // change nobody committed, and the one it would destroy is the one that
      // matters. Set aside once, under a name that says what it is; a second
      // orphan while the first is still there is refused rather than piled up,
      // since these carry gigabytes of build output.
      if (await exists(worktree.path)) {
        const aside = `${worktree.path}.orphaned`;
        if (await exists(aside)) {
          throw new SquadError(
            "orphaned_checkout",
            409,
            `the checkout at ${worktree.path} lost its git administrative entry, and a previous one is already set aside at ${aside}: deal with that one before squad opens another`,
          );
        }
        await rename(worktree.path, aside);
      }
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

/**
 * Whether a path holds a checkout squad can work in: it is there, and git knows
 * it as one of its own. The two questions are asked together because a caller
 * only ever wants the answer to both.
 */
async function usable(path: string): Promise<boolean> {
  return (await exists(path)) && (await isCheckout(path));
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
