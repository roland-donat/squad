import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody, Feature, Project } from "../../src/shared/api";
import { startTestSquad, type TestSquad } from "../support/squad";
import { createTemporaryRepository } from "../support/git";

describe("opening a feature", () => {
  let squad: TestSquad;

  beforeEach(async () => {
    squad = await startTestSquad();
  });

  afterEach(async () => {
    await squad.dispose();
  });

  async function registerProject(): Promise<Project> {
    const repository = await createTemporaryRepository();
    const response = await squad.request("POST", "/api/projects", { path: repository });
    const { project } = (await response.json()) as { project: Project };
    return project;
  }

  it("opens a feature on a project and lists it back", async () => {
    const project = await registerProject();

    const response = await squad.request("POST", "/api/features", {
      projectId: project.id,
      title: "Fondation",
    });

    expect(response.status).toBe(201);
    const { feature } = (await response.json()) as { feature: Feature };
    expect(feature.title).toBe("Fondation");
    expect(feature.projectId).toBe(project.id);

    const listed = await squad.request("GET", "/api/features");
    const { features } = (await listed.json()) as { features: Feature[] };
    expect(features).toEqual([feature]);
  });

  it("carries several features on the same project", async () => {
    const project = await registerProject();
    await squad.request("POST", "/api/features", { projectId: project.id, title: "Courte" });
    await squad.request("POST", "/api/features", { projectId: project.id, title: "Longue" });

    const listed = await squad.request("GET", `/api/features?projectId=${project.id}`);
    const { features } = (await listed.json()) as { features: Feature[] };
    expect(features.map((feature) => feature.title)).toEqual(["Courte", "Longue"]);
  });

  it("opens a feature configured, rather than configured a moment later", async () => {
    const project = await registerProject();
    const also = await registerProject();

    // Everything the creation screen asks for, in the one call that opens the
    // feature: a feature must never exist under a mode nobody chose, even for
    // the moment a second request would take.
    const response = await squad.request("POST", "/api/features", {
      projectId: project.id,
      title: "Fondation",
      otherProjectIds: [also.id],
      goAsRecommended: true,
    });

    expect(response.status).toBe(201);
    const { feature } = (await response.json()) as { feature: Feature };
    expect(feature.goAsRecommended).toBe(true);
    expect(feature.repositories.map((carried) => carried.projectId)).toEqual([
      project.id,
      also.id,
    ]);

    // And it is what squad holds, not merely what the answer said.
    const listed = await squad.request("GET", "/api/features");
    const { features } = (await listed.json()) as { features: Feature[] };
    expect(features[0]?.goAsRecommended).toBe(true);
  });

  it("leaves the mode off when the opening says nothing of it", async () => {
    const project = await registerProject();
    const response = await squad.request("POST", "/api/features", {
      projectId: project.id,
      title: "Fondation",
    });

    const { feature } = (await response.json()) as { feature: Feature };
    expect(feature.goAsRecommended).toBe(false);
  });

  it("refuses a feature on an unknown project", async () => {
    const response = await squad.request("POST", "/api/features", {
      projectId: "unknown",
      title: "Fondation",
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("project_not_found");
  });

  it("refuses a feature without a title", async () => {
    const project = await registerProject();
    const response = await squad.request("POST", "/api/features", {
      projectId: project.id,
      title: "   ",
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("invalid_request");
  });
});

describe("persistence", () => {
  let squad: TestSquad;

  beforeEach(async () => {
    squad = await startTestSquad();
  });

  afterEach(async () => {
    await squad.dispose();
  });

  it("keeps projects and features across a server restart", async () => {
    const repository = await createTemporaryRepository();
    const created = await squad.request("POST", "/api/projects", { path: repository });
    const { project } = (await created.json()) as { project: Project };
    await squad.request("POST", "/api/features", { projectId: project.id, title: "Fondation" });

    await squad.restart();

    const projects = (await (await squad.request("GET", "/api/projects")).json()) as {
      projects: Project[];
    };
    const features = (await (await squad.request("GET", "/api/features")).json()) as {
      features: Feature[];
    };
    expect(projects.projects).toEqual([project]);
    expect(features.features.map((feature) => feature.title)).toEqual(["Fondation"]);

    // The interface reads none of the routes above: it holds what the snapshot
    // of a fresh connection gives it, so that is what has to survive too.
    const stream = await squad.openEventStream();
    const snapshot = await stream.next();
    if (snapshot.type !== "snapshot") throw new Error("the first event is not a snapshot");
    expect(snapshot.projects).toEqual([project]);
    expect(snapshot.features.map((feature) => feature.title)).toEqual(["Fondation"]);
  });
});
