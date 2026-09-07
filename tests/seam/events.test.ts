import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../../src/shared/api";
import { startTestSquad, type TestSquad } from "../support/squad";
import { createTemporaryRepository } from "../support/git";

describe("the event stream", () => {
  let squad: TestSquad;

  beforeEach(async () => {
    squad = await startTestSquad();
  });

  afterEach(async () => {
    await squad.dispose();
  });

  it("opens with a snapshot of the whole state", async () => {
    const repository = await createTemporaryRepository();
    const created = await squad.request("POST", "/api/projects", { path: repository });
    const { project } = (await created.json()) as { project: Project };
    await squad.request("POST", "/api/features", { projectId: project.id, title: "Fondation" });

    const stream = await squad.openEventStream();
    const snapshot = await stream.next();

    expect(snapshot.type).toBe("snapshot");
    if (snapshot.type !== "snapshot") throw new Error("unreachable");
    expect(snapshot.projects).toEqual([project]);
    expect(snapshot.features.map((feature) => feature.title)).toEqual(["Fondation"]);
  });

  it("announces a project and a feature as they appear", async () => {
    const stream = await squad.openEventStream();
    await stream.next();

    const repository = await createTemporaryRepository();
    const created = await squad.request("POST", "/api/projects", { path: repository });
    const { project } = (await created.json()) as { project: Project };

    const registered = await stream.next();
    expect(registered).toEqual({ type: "project-registered", project });

    await squad.request("POST", "/api/features", { projectId: project.id, title: "Fondation" });
    const opened = await stream.next();
    expect(opened.type).toBe("feature-opened");
    if (opened.type !== "feature-opened") throw new Error("unreachable");
    expect(opened.feature.title).toBe("Fondation");
  });
});
