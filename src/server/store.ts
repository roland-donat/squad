import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Feature, Project, Snapshot } from "../shared/api";
import type { SquadDatabase } from "./db/open";
import { features, projects } from "./db/schema";
import { SquadError } from "./errors";
import { inspectGitRepository } from "./git";
import { isInside } from "./paths";

export interface RegisterProjectInput {
  path: string;
  name?: string | undefined;
}

export interface OpenFeatureInput {
  projectId: string;
  title: string;
}

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

  async registerProject(input: RegisterProjectInput): Promise<Project> {
    const repository = await inspectGitRepository(input.path);

    if (isInside(this.dataDir, repository.root)) {
      throw new SquadError(
        "data_directory_inside_project",
        400,
        `squad stores its database in ${this.dataDir}, which is inside ${repository.root}`,
      );
    }

    const existing = this.db
      .select()
      .from(projects)
      .where(eq(projects.path, repository.root))
      .get();
    if (existing) {
      throw new SquadError(
        "project_already_registered",
        409,
        `${repository.root} is already registered as project ${existing.id}`,
      );
    }

    const project: Project = {
      id: randomUUID(),
      name: input.name ?? basename(repository.root),
      path: repository.root,
      defaultBranch: repository.currentBranch,
      createdAt: new Date().toISOString(),
    };
    this.db.insert(projects).values(project).run();
    return project;
  }

  openFeature(input: OpenFeatureInput): Feature {
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
