import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realpath } from "node:fs/promises";
import type { ApiErrorBody, Project, Ticket } from "../../src/shared/api";
import {
  apiRoutes,
  featureGraphRoute,
  projectRoute,
  ticketSessionRoute,
} from "../../src/shared/api";
import { connectToSquadTools, writeTicket } from "../support/mcp";
import { createScriptedLauncher } from "../support/scripted-launcher";
import { openTestFeature, startTestSquad, type TestSquad } from "../support/squad";
import {
  createBranch,
  createTemporaryDirectory,
  createTemporaryRepository,
} from "../support/git";

describe("registering a project", () => {
  let squad: TestSquad;

  beforeEach(async () => {
    squad = await startTestSquad();
  });

  afterEach(async () => {
    await squad.dispose();
  });

  it("registers a git repository and lists it back", async () => {
    const repository = await createTemporaryRepository();

    const response = await squad.request("POST", "/api/projects", { path: repository });
    expect(response.status).toBe(201);

    const { project } = (await response.json()) as { project: Project };
    expect(project.path).toBe(await realpath(repository));
    expect(project.id).toBeTruthy();

    const listed = await squad.request("GET", "/api/projects");
    expect(listed.status).toBe(200);
    const { projects } = (await listed.json()) as { projects: Project[] };
    expect(projects).toEqual([project]);
  });

  it("names the project after the repository directory by default", async () => {
    const repository = await createTemporaryRepository();
    const response = await squad.request("POST", "/api/projects", { path: repository });
    const { project } = (await response.json()) as { project: Project };
    expect(project.name).toBe(repository.split("/").at(-1));
  });

  it("keeps the name given by the pilot", async () => {
    const repository = await createTemporaryRepository();
    const response = await squad.request("POST", "/api/projects", {
      path: repository,
      name: "Poste de pilotage",
    });
    const { project } = (await response.json()) as { project: Project };
    expect(project.name).toBe("Poste de pilotage");
  });

  it("refuses a path that is not a git repository", async () => {
    const directory = await createTemporaryDirectory();

    const response = await squad.request("POST", "/api/projects", { path: directory });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("not_a_git_repository");
    expect(body.error.message).toContain(directory);
  });

  it("refuses a path that does not exist", async () => {
    const response = await squad.request("POST", "/api/projects", {
      path: "/nowhere/squad-does-not-exist",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("path_not_found");
  });

  it("tells an unreadable path from a missing one", async () => {
    // A path whose parent is a file: it exists in no sense, but the failure is
    // not that it is absent.
    const response = await squad.request("POST", "/api/projects", {
      path: "/etc/hostname/inside-a-file",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("path_not_readable");
  });

  it("refuses a request without a path", async () => {
    const response = await squad.request("POST", "/api/projects", {});
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("invalid_request");
  });

  it("refuses to register the same repository twice", async () => {
    const repository = await createTemporaryRepository();
    await squad.request("POST", "/api/projects", { path: repository });

    const again = await squad.request("POST", "/api/projects", { path: repository });

    expect(again.status).toBe(409);
    const body = (await again.json()) as ApiErrorBody;
    expect(body.error.code).toBe("project_already_registered");
  });

  it("refuses a repository that would contain squad's own data directory", async () => {
    // The database must never live inside a repository squad drives, since a
    // ticket's worktree would then carry it around.
    const repository = await createTemporaryRepository();
    const inside = await startTestSquad({ dataDir: `${repository}/.squad-data` });
    try {
      const response = await inside.request("POST", "/api/projects", { path: repository });
      expect(response.status).toBe(400);
      const body = (await response.json()) as ApiErrorBody;
      expect(body.error.code).toBe("data_directory_inside_project");
    } finally {
      await inside.dispose();
    }
  });
});

/**
 * What the settings screen changes on a project, through the same route it
 * uses. A project's own settings are checked exactly as a registration is: the
 * screen is not a back door onto a directory that is not a repository, nor onto
 * a branch that is not there.
 */
describe("changing a project's settings", () => {
  let squad: TestSquad;

  beforeEach(async () => {
    squad = await startTestSquad();
  });

  afterEach(async () => {
    await squad.dispose();
  });

  /** A registered project, as the settings screen finds it. */
  async function register(path: string): Promise<Project> {
    const response = await squad.request("POST", apiRoutes.projects, { path });
    expect(response.status).toBe(201);
    const { project } = (await response.json()) as { project: Project };
    return project;
  }

  it("changes the path, the default branch, the check and the cap", async () => {
    const repository = await createTemporaryRepository();
    const project = await register(repository);
    const moved = await createTemporaryRepository();
    await createBranch(moved, "principale");

    const response = await squad.request("PUT", projectRoute(project.id), {
      path: moved,
      defaultBranch: "principale",
      verifyCommand: "pnpm verify",
      featureConcurrencyCap: 2,
    });

    expect(response.status).toBe(200);
    const { project: changed } = (await response.json()) as { project: Project };
    expect(changed.path).toBe(await realpath(moved));
    expect(changed.defaultBranch).toBe("principale");
    expect(changed.verifyCommand).toBe("pnpm verify");
    expect(changed.featureConcurrencyCap).toBe(2);

    // What was not named is left as it stands, and an empty command clears it.
    const cleared = await squad.request("PUT", projectRoute(project.id), { verifyCommand: "" });
    const { project: last } = (await cleared.json()) as { project: Project };
    expect(last.verifyCommand).toBeNull();
    expect(last.defaultBranch).toBe("principale");
  });

  it("refuses a default branch the repository does not have", async () => {
    const project = await register(await createTemporaryRepository());

    const response = await squad.request("PUT", projectRoute(project.id), {
      defaultBranch: "principale",
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("branch_not_found");
  });

  it("refuses a path that is not a git repository, and one already registered", async () => {
    const project = await register(await createTemporaryRepository());
    const other = await register(await createTemporaryRepository());

    const plain = await squad.request("PUT", projectRoute(project.id), {
      path: await createTemporaryDirectory(),
    });
    expect(plain.status).toBe(400);
    expect(((await plain.json()) as ApiErrorBody).error.code).toBe("not_a_git_repository");

    const taken = await squad.request("PUT", projectRoute(project.id), { path: other.path });
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as ApiErrorBody).error.code).toBe("project_already_registered");
  });

  it("refuses to move a project out from under work that is checked out", async () => {
    // A sub-session that stays where it is: what matters is that a checkout of
    // this project exists while the path is being changed.
    let park = () => {};
    const parked = new Promise<void>((resolve) => {
      park = resolve;
    });
    const running = await startTestSquad({
      launcher: createScriptedLauncher(async (agent) => {
        await agent.awaitMessage();
        await parked;
      }),
    });
    try {
      const { project, feature } = await openTestFeature(running, "Le noyau");
      const tools = await connectToSquadTools(running.url);
      const created = (await writeTicket(tools, {
        featureId: feature.id,
        kind: "build",
        title: "Le store",
        description: "La base et ses migrations.",
      })) as Ticket;
      await tools.close();
      await running.request("POST", ticketSessionRoute(created.id), {});
      await expect
        .poll(async () => {
          const response = await running.request("GET", featureGraphRoute(feature.id));
          const graph = (await response.json()) as { tickets: Ticket[] };
          return graph.tickets[0]?.state;
        }, { timeout: 15_000 })
        .toBe("running");

      const response = await running.request("PUT", projectRoute(project.id), {
        path: await createTemporaryRepository(),
      });

      expect(response.status).toBe(409);
      const body = (await response.json()) as ApiErrorBody;
      expect(body.error.code).toBe("project_has_work_in_flight");
      expect(body.error.message).toContain("Le noyau");
      // Nothing moved: the project still points where its worktrees came from.
      const listed = await running.request("GET", apiRoutes.projects);
      const { projects } = (await listed.json()) as { projects: Project[] };
      expect(projects[0]?.path).toBe(project.path);
    } finally {
      park();
      await running.dispose();
    }
  });
});
