import { keyOf, nextLaunches, type Launch, type LaunchJob, type ScheduledFeature } from "./scheduler";

/**
 * What turns the scheduler's answer into open sessions, in one place for the
 * three kinds squad opens. The scheduler decides and stays pure; this holds the
 * places it hands out, opens what it named, and asks it again whenever
 * something may have moved.
 *
 * It exists because the count has to be one count. A settling pass and a
 * conflict resolution used to open their session where they were needed, held
 * by an in-memory set of their own: three counters, none of them a cap, and ten
 * sheets reported together meant ten claude-code sessions on the machine at
 * once.
 */
export interface DispatchDependencies {
  store: {
    scheduledFeatures(): ScheduledFeature[];
    settings(): { machineConcurrencyCap: number };
  };
  /**
   * How each kind of session is opened. Each resolves once its place is no
   * longer held here, either because the state now says it is open or because
   * it never opened at all: the scheduler counts a key once, whichever of the
   * two says so.
   */
  open: Record<LaunchJob, (ticketId: string) => Promise<void>>;
}

export class Dispatch {
  private readonly opening = new Map<string, Promise<void>>();
  private stopping = false;

  constructor(private readonly dependencies: DispatchDependencies) {}

  /**
   * Opens what the caps allow, and nothing more. Called every time the state it
   * reads may have moved: a launch asked for, a session ended, a cap raised. It
   * decides nothing itself, the scheduler does, and it never opens the same
   * thing twice, since the place is held before anything is awaited.
   */
  schedule(): void {
    if (this.stopping) return;
    const { store, open } = this.dependencies;
    const launches = nextLaunches({
      features: store.scheduledFeatures(),
      machineCap: store.settings().machineConcurrencyCap,
      opening: [...this.opening.keys()].map(launchOf),
    });
    for (const launch of launches) {
      const key = keyOf(launch);
      // Held as a promise that never rejects: a shutdown awaits these to know
      // nothing is half open, and one rejection would leave the others waited
      // on by nobody. Whatever opening could not deal with is a bug, and it is
      // logged rather than left to take the process down.
      const opening = open[launch.job](launch.ticketId).catch((failure: unknown) => {
        console.error(`opening the ${launch.job} of ticket ${launch.ticketId} failed`, failure);
      });
      this.opening.set(key, opening);
      void opening.then(() => {
        this.opening.delete(key);
        // Something that could not be opened gives its place straight back, and
        // whatever was behind it in the queue takes it.
        this.schedule();
      });
    }
  }

  /** Whether this exact session is being opened right now. */
  isOpening(launch: Launch): boolean {
    return this.opening.has(keyOf(launch));
  }

  /**
   * Stops handing places out. Called before the sessions are stopped, so that
   * nothing opens behind a shutdown that has already been through the list.
   */
  halt(): void {
    this.stopping = true;
  }

  /**
   * Waits for what was half open to have opened. Called after the sessions are
   * stopped: what is awaited here is the opening of a session, never its life,
   * so a shutdown never waits on a session it has not stopped.
   */
  async drain(): Promise<void> {
    await Promise.all([...this.opening.values()]);
  }
}

/** The inverse of `keyOf`, the map being keyed by what the scheduler counts. */
function launchOf(key: string): Launch {
  const cut = key.indexOf(":");
  return { job: key.slice(0, cut) as LaunchJob, ticketId: key.slice(cut + 1) };
}
