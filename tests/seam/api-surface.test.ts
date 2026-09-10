import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody } from "../../src/shared/api";
import { startTestSquad, type TestSquad } from "../support/squad";

describe("the API surface", () => {
  let squad: TestSquad;

  beforeEach(async () => {
    squad = await startTestSquad();
  });

  afterEach(async () => {
    await squad.dispose();
  });

  it("answers an unknown API route as an API route", async () => {
    // Not as the interface shell: a caller asking for JSON must not receive a
    // page with a 200 on it.
    const response = await squad.request("GET", "/api/nowhere");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("not_found");
  });

  it("answers an unknown API route the same way on a write", async () => {
    const response = await squad.request("POST", "/api/nowhere", {});
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe("not_found");
  });
});

describe("the interface shell", () => {
  let squad: TestSquad;
  let buildRoot: string;

  beforeEach(async () => {
    buildRoot = await mkdtemp(join(tmpdir(), "squad-ui-"));
    // Under a dot directory on purpose. Squad is installed in
    // ~/.local/lib/squad, and what serves a file refuses any path holding a
    // dot segment: served from a build named by its absolute path, every route
    // of the interface answers 404 while the API answers 200. Built at a plain
    // path, this scenario would stay green on a machine where nothing works.
    const buildDir = join(buildRoot, ".local", "lib", "squad", "dist", "ui");
    await mkdir(buildDir, { recursive: true });
    await writeFile(join(buildDir, "index.html"), "<!doctype html><title>squad</title>\n");
    squad = await startTestSquad({ ui: "static", uiBuild: buildDir });
  });

  afterEach(async () => {
    await squad.dispose();
    await rm(buildRoot, { recursive: true, force: true });
  });

  it("renders the shell on a route only the browser knows", async () => {
    const response = await squad.request("GET", "/features/9c16011e-2ac0-4479-89b4-e84d392434d3");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>squad</title>");
  });

  it("leaves the API to the API, shell or no shell", async () => {
    // The fallback claims every path the API did not: a JSON caller must still
    // receive JSON, and never a page with a 200 on it.
    const response = await squad.request("GET", "/api/nowhere");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
