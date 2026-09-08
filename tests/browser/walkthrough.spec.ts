import { realpath } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { Feature, Project, Settings, Ticket } from "../../src/shared/api";
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
  // Nothing blocks this one, so it is waiting on the developer right now: it is
  // what the indicator has to list.
  await tools.call("create_ticket", {
    featureId: feature.id,
    kind: "decision",
    title: "Quelle base",
    description: "SQLite ou autre.",
  });
  await tools.close();

  // Four nodes and the two arrows between them, without a reload: the graph
  // arrives on the event stream while it is being written.
  const nodes = page.getByRole("region", { name: "Graphe" }).getByRole("button");
  await expect(nodes).toHaveCount(4);
  await expect(page.getByLabel("Le store, construction, prêt")).toBeVisible();
  await expect(page.getByLabel("Les outils MCP, construction, bloqué")).toBeVisible();
  await expect(page.getByLabel("Quelle disposition, décision, bloqué")).toBeVisible();
  await expect(page.locator(".graph__edge")).toHaveCount(2);

  // The indicator lists what waits on the developer, and opens it: the decision
  // nothing blocks is there, the one still blocked is not.
  const waiting = page.getByRole("region", { name: "En attente de moi" });
  await expect(waiting.getByRole("button")).toHaveCount(1);
  const entry = waiting.getByRole("button", { name: /Quelle base/ });
  await expect(entry).toContainText("décision à trancher");
  await entry.click();
  await expect(page.getByRole("region", { name: "Ticket" }).getByText("SQLite ou autre.")).toBeVisible();

  // Clicking a node opens the ticket: what it asks for, and the thread of the
  // sub-session that will build it. Nothing is launched here, since this
  // walk-through runs against the real launcher.
  await page.getByLabel("Le store, construction, prêt").click();
  const opened = page.getByRole("region", { name: "Ticket" });
  await expect(opened.getByText("La base et ses migrations.")).toBeVisible();
  await expect(opened.getByText("Aucune sous-session pour l'instant.")).toBeVisible();
  await expect(opened.getByRole("button", { name: "Lancer le ticket" })).toBeVisible();

  // A blocked ticket offers no launch: the arrows of the graph mean something.
  await page.getByLabel("Les outils MCP, construction, bloqué").click();
  await expect(opened.getByRole("button", { name: "Lancer le ticket" })).toBeHidden();

  await opened.getByRole("button", { name: "fermer" }).click();
  await expect(page.getByRole("region", { name: "Session principale" })).toBeVisible();

  // Go-as-recommandé, on the feature it drives. It is armed here on a feature
  // whose graph is empty, so squad has nothing to launch and this walk-through
  // opens no session: what is proven is the control, not the drain, which the
  // seam covers with a scripted agent.
  const featuresPanel = page.getByRole("region", { name: "Features" });
  await page.getByLabel("Intitulé de la feature").fill("Sans graphe");
  await page.getByRole("button", { name: "Ouvrir la feature" }).click();
  await featuresPanel.getByRole("button", { name: "go-as-recommandé : arrêté" }).click();
  await expect(
    featuresPanel.getByRole("button", { name: "go-as-recommandé : en cours" }),
  ).toBeVisible();
  await featuresPanel.getByRole("button", { name: "arrêter" }).click();
  await expect(
    featuresPanel.getByRole("button", { name: "go-as-recommandé : arrêté" }),
  ).toBeVisible();

  // The settings screen: what squad is configured with, changed where it is
  // read. Both scopes are on it, the machine's and the project's.
  await page.getByRole("button", { name: "réglages" }).click();
  const machine = page.getByRole("region", { name: "Réglages de la machine" });
  await machine.getByLabel("Profondeur d'engendrement maximale").fill("2");
  await machine.getByRole("button", { name: "Enregistrer les réglages" }).click();
  await expect(machine.getByText("Enregistré.")).toBeVisible();

  const ofProject = page.getByRole("group", { name: repositoryRoot.split("/").at(-1) ?? "" });
  await ofProject.getByLabel("Commande de vérification").fill("pnpm verify");
  await ofProject.getByRole("button", { name: "Enregistrer le projet" }).click();
  await expect(ofProject.getByText("Enregistré.")).toBeVisible();

  // Held by the server, not by the screen: what was typed is what squad applies.
  const { settings } = (await (await request.get("/api/settings")).json()) as {
    settings: Settings;
  };
  expect(settings.generationDepthCap).toBe(2);
  const { projects } = (await (await request.get("/api/projects")).json()) as {
    projects: Project[];
  };
  expect(projects.at(-1)?.verifyCommand).toBe("pnpm verify");

  await page.getByRole("button", { name: "revenir au pilotage" }).click();

  // The state lives on the server, so it survives a reload of the page.
  await page.reload();
  await expect(nodes).toHaveCount(4);
});
