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
