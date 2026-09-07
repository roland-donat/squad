import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realpath } from "node:fs/promises";
import type { ApiErrorBody, Project } from "../../src/shared/api";
import { startTestSquad, type TestSquad } from "../support/squad";
import { createTemporaryDirectory, createTemporaryRepository } from "../support/git";

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
