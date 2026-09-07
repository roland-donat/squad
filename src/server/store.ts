import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { eq, sql } from "drizzle-orm";
import type {
  Feature,
  OpenFeatureBody,
  Project,
  RegisterProjectBody,
  Snapshot,
} from "../shared/api";
import type { SquadDatabase } from "./db/open";
import { features, projects } from "./db/schema";
import { SquadError } from "./errors";
import { resolveRepositoryRoot } from "./git";
import { isInside } from "./paths";

/**
 * Every read and write of squad's durable state. Rows are ordered by SQLite's
 * `rowid`, which is insertion order: two features opened within the same
 * millisecond would otherwise come back in an undefined order.
 */
export class Store {
  constructor(
    private readonly db: SquadDatabase,
    private readonly dataDir: string,
  ) {}

  listProjects(): Project[] {
    return this.db.select().from(projects).orderBy(sql`rowid`).all();
  }

  listFeatures(projectId?: string): Feature[] {
    const query = this.db.select().from(features).$dynamic();
    if (projectId !== undefined) query.where(eq(features.projectId, projectId));
    return query.orderBy(sql`rowid`).all();
  }

  snapshot(): Snapshot {
    return { projects: this.listProjects(), features: this.listFeatures() };
  }

  async registerProject(input: RegisterProjectBody): Promise<Project> {
    const root = await resolveRepositoryRoot(input.path);

    if (isInside(this.dataDir, root)) {
      throw new SquadError(
        "data_directory_inside_project",
        400,
        `squad stores its database in ${this.dataDir}, which is inside ${root}`,
      );
    }

    const project: Project = {
      id: randomUUID(),
      name: input.name ?? basename(root),
      path: root,
      createdAt: new Date().toISOString(),
    };

    try {
      this.db.insert(projects).values(project).run();
    } catch (cause) {
      // The unique index on `path` is what actually decides, rather than a
      // preliminary read: two registrations of the same repository can be in
      // flight at once, since resolving the path awaits git.
      if (isUniqueViolation(cause)) {
        throw new SquadError(
          "project_already_registered",
          409,
          `${root} is already registered as a project`,
        );
      }
      throw cause;
    }
    return project;
  }

  openFeature(input: OpenFeatureBody): Feature {
    const project = this.db.select().from(projects).where(eq(projects.id, input.projectId)).get();
    if (!project) {
      throw new SquadError("project_not_found", 404, `no project with id ${input.projectId}`);
    }

    const feature: Feature = {
      id: randomUUID(),
      projectId: project.id,
      title: input.title,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(features).values(feature).run();
    return feature;
  }
}

function isUniqueViolation(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    typeof cause.code === "string" &&
    cause.code.startsWith("SQLITE_CONSTRAINT")
  );
}
