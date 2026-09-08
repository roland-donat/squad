import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiRoutes, type Settings } from "../../src/shared/api";
import { startTestSquad, type TestSquad } from "../support/squad";

describe("the settings", () => {
  let squad: TestSquad;

  beforeEach(async () => {
    squad = await startTestSquad();
  });

  afterEach(async () => {
    await squad.dispose();
  });

  it("leaves the ground to the browser until something else is asked", async () => {
    const response = await squad.request("GET", apiRoutes.settings);

    const { settings } = (await response.json()) as { settings: Settings };
    expect(settings.theme).toBe("system");
  });

  it("holds the chosen ground, and announces it like any other setting", async () => {
    const stream = await squad.openEventStream();
    await stream.next();

    const response = await squad.request("PUT", apiRoutes.settings, { theme: "dark" });

    expect(response.status).toBe(200);
    const announced = await stream.next();
    expect(announced.type).toBe("settings-changed");
    if (announced.type !== "settings-changed") throw new Error("unreachable");
    expect(announced.settings.theme).toBe("dark");

    // Read back on its own, since the interface asks for nothing and a value
    // only on the stream would be lost by the next connection.
    const reread = await squad.request("GET", apiRoutes.settings);
    const { settings } = (await reread.json()) as { settings: Settings };
    expect(settings.theme).toBe("dark");
  });

  it("leaves the rest of the settings alone when only the ground changes", async () => {
    await squad.request("PUT", apiRoutes.settings, { machineConcurrencyCap: 2 });
    await squad.request("PUT", apiRoutes.settings, { theme: "light" });

    const response = await squad.request("GET", apiRoutes.settings);
    const { settings } = (await response.json()) as { settings: Settings };
    expect(settings).toMatchObject({ theme: "light", machineConcurrencyCap: 2 });
  });

  it("refuses a ground it does not know", async () => {
    const response = await squad.request("PUT", apiRoutes.settings, { theme: "midnight" });

    expect(response.status).toBe(400);
    const reread = await squad.request("GET", apiRoutes.settings);
    const { settings } = (await reread.json()) as { settings: Settings };
    expect(settings.theme).toBe("system");
  });
});
