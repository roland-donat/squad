import { realpath } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Feature, Ticket } from "../../src/shared/api";
import { createTemporaryRepository, removeTemporaryPaths } from "../support/git";
import { connectToSquadTools } from "../support/mcp";

test.afterAll(removeTemporaryPaths);

test("registers a project, opens a feature and reads the graph an agent wrote", async ({
  page,
  request,
  baseURL,
}) => {
  const repository = await createTemporaryRepository();
  // The server stores the path git reports, with its symlinks resolved.
  const repositoryRoot = await realpath(repository);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "squad" })).toBeVisible();

  await page.getByLabel("Chemin du dépôt").fill(repository);
  await page.getByRole("button", { name: "Enregistrer le projet" }).click();

  await expect(page.getByText(repositoryRoot, { exact: true })).toBeVisible();

  await page.getByLabel("Intitulé de la feature").fill("Fondation");
  await page.getByRole("button", { name: "Ouvrir la feature" }).click();

  // Listed among the features, and opened: the graph panel names it, and the
  // thread of its main session is there waiting to be written to.
  await expect(page.getByRole("button", { name: /^Fondation/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Graphe" }).getByText("Fondation")).toBeVisible();

  const session = page.getByRole("region", { name: "Session principale" });
  await expect(session.getByText("Fil vide.")).toBeVisible();
  await expect(session.getByRole("button", { name: "Ouvrir la session principale" })).toBeVisible();

  // The graph is written by an agent through squad's tools, never by the
  // interface: the walk-through writes it the way an agent would.
  const listed = await request.get("/api/features");
  const { features } = (await listed.json()) as { features: Feature[] };
  const feature = features.at(-1);
  if (!feature) throw new Error("the feature just opened is missing from the API");

  const tools = await connectToSquadTools(baseURL ?? "");
  const store = (await tools.call("create_ticket", {
    featureId: feature.id,
    kind: "build",
    title: "Le store",
    description: "La base et ses migrations.",
  })) as Ticket;
  const mcp = (await tools.call("create_ticket", {
    featureId: feature.id,
    kind: "build",
    title: "Les outils MCP",
    description: "Le contrat avec les agents.",
    blockedBy: [store.id],
  })) as Ticket;
  await tools.call("create_ticket", {
    featureId: feature.id,
    kind: "decision",
    title: "Quelle disposition",
    description: "À trancher.",
    blockedBy: [mcp.id],
  });
  await tools.close();

  // Three nodes and the two arrows between them, without a reload: the graph
  // arrives on the event stream while it is being written.
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByLabel("Le store, construction, prêt")).toBeVisible();
  await expect(page.getByLabel("Les outils MCP, construction, bloqué")).toBeVisible();
  await expect(page.getByLabel("Quelle disposition, décision, bloqué")).toBeVisible();
  await expect(page.locator(".graph__edge")).toHaveCount(2);

  // The state lives on the server, so it survives a reload of the page.
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(3);
});
