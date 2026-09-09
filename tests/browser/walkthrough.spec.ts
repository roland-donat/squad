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

  await page.getByRole("button", { name: "enregistrer un projet" }).click();
  await page.getByLabel("Chemin du dépôt").fill(repository);
  await page.getByRole("button", { name: "Enregistrer le projet" }).click();

  // Registered, listed in the rail, and the dialog closed itself on the way.
  await expect(page.getByText(repositoryRoot, { exact: true })).toBeVisible();
  await expect(page.locator("dialog[open]")).toHaveCount(0);

  await page.getByRole("button", { name: "ouvrir une feature" }).click();
  await page.getByLabel("Intitulé de la feature").fill("Fondation");
  await page.getByRole("button", { name: "Ouvrir la feature" }).click();

  // Listed among the features, and opened: the graph panel names it, and the
  // thread of its main session is there waiting to be written to.
  await expect(page.getByRole("button", { name: /^Fondation/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Graphe" }).getByText("Fondation")).toBeVisible();

  const session = page.getByRole("region", { name: "Session principale" });
  await expect(session.getByText("Fil vide.")).toBeVisible();
  await expect(session.getByRole("button", { name: "Ouvrir la session principale" })).toBeVisible();
  // The shortcuts of the main session, not clicked here: doing so would open a
  // real claude-code session, which this walk-through never does.
  await expect(session.getByRole("button", { name: "/to-spec" })).toBeVisible();
  await expect(session.getByRole("button", { name: "/to-tickets" })).toBeVisible();

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
  const nodes = page.getByRole("region", { name: "Graphe" }).locator(".node");
  await expect(nodes).toHaveCount(4);
  await expect(page.getByLabel("Le store, construction, prêt")).toBeVisible();
  await expect(page.getByLabel("Les outils MCP, construction, bloqué")).toBeVisible();
  await expect(page.getByLabel("Quelle disposition, décision, bloqué")).toBeVisible();
  await expect(page.locator(".graph__edge")).toHaveCount(2);

  // The map is navigated rather than scrolled: the wheel zooms, and the key
  // that recentres puts it back exactly where the framing had left it. The
  // framing is a function of the graph and the viewport, so it is reproducible.
  const map = page.locator(".graph");
  const framing = () => map.evaluate((element) => element.style.transform);
  const framed = await framing();
  await page.locator(".graph__viewport").hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(framing).not.toBe(framed);
  await page.locator(".graph__viewport").focus();
  await page.keyboard.press("0");
  await expect.poll(framing).toBe(framed);

  // One tab stop for the whole map, whatever it holds: the arrows walk from
  // node to node inside it.
  await expect(page.locator(".node[tabindex='0']")).toHaveCount(1);

  // The indicator lists what waits on the developer, and opens it: the decision
  // nothing blocks is there, the one still blocked is not.
  const waiting = page.getByRole("region", { name: "Actions en attente" });
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

  // A second repository, and a feature carrying both: the graph then says on
  // every node which one builds it, since the answer stops being the same
  // everywhere.
  const second = await createTemporaryRepository();
  await page.getByRole("button", { name: "enregistrer un projet" }).click();
  await page.getByLabel("Chemin du dépôt").fill(second);
  await page.getByRole("button", { name: "Enregistrer le projet" }).click();
  await expect(page.getByText(await realpath(second), { exact: true })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(repositoryRoot.split("/").at(-1) ?? "") }).click();

  await page.getByRole("button", { name: "ouvrir une feature" }).click();
  await page.getByLabel("Intitulé de la feature").fill("Sur deux dépôts");
  await page.getByLabel(second.split("/").at(-1) ?? "").check();
  await page.getByRole("button", { name: "Ouvrir la feature" }).click();
  await expect(
    page.getByRole("region", { name: "Graphe" }).getByText(/2 dépôts/),
  ).toBeVisible();

  const withBoth = await request.get("/api/features");
  const { features: carried } = (await withBoth.json()) as { features: Feature[] };
  const carrying = carried.at(-1);
  if (!carrying) throw new Error("the feature just opened is missing from the API");
  const both = await connectToSquadTools(baseURL ?? "");
  await both.call("create_ticket", {
    featureId: carrying.id,
    kind: "build",
    title: "Ici",
    description: "Dans le dépôt d'attache.",
  });
  await both.call("create_ticket", {
    featureId: carrying.id,
    projectId: carrying.repositories[1]?.projectId,
    kind: "build",
    title: "Là-bas",
    description: "Dans l'autre dépôt.",
  });
  await both.close();

  const elsewhere = second.split("/").at(-1) ?? "";
  await expect(page.getByLabel(`Là-bas, construction, prêt, ${elsewhere}`)).toBeVisible();
  await expect(
    page.getByLabel(`Ici, construction, prêt, ${repositoryRoot.split("/").at(-1)}`),
  ).toBeVisible();

  // The conversations claude-code has recorded, which is where a feature comes
  // from when it comes from work already done. What is on this machine is
  // nobody's business here: what is proven is that the panel asks squad and
  // renders the answer, so the search is given something nothing can match.
  await page.getByRole("button", { name: "reprendre une conversation" }).click();
  const recorded = page.getByRole("region", { name: "Reprendre une session" });
  await expect(recorded.getByLabel("Rechercher une session")).toBeVisible();
  await recorded.getByLabel("Rechercher une session").fill("zzz-aucune-conversation-zzz");
  await expect(recorded.getByText("Aucune conversation ne correspond.")).toBeVisible();
  await recorded.getByLabel("Rechercher une session").fill("");
  await page.getByRole("button", { name: "fermer" }).click();

  // Go-as-recommandé, on the feature it drives. It is armed here on a feature
  // whose graph is empty, so squad has nothing to launch and this walk-through
  // opens no session: what is proven is the control, not the drain, which the
  // seam covers with a scripted agent.
  const featuresPanel = page.getByRole("region", { name: "Features" });
  const graphPanel = page.getByRole("region", { name: "Graphe" });
  await page.getByRole("button", { name: "ouvrir une feature" }).click();
  await page.getByLabel("Intitulé de la feature").fill("Sans graphe");
  await page.getByRole("button", { name: "Ouvrir la feature" }).click();
  await graphPanel.getByRole("button", { name: "go-as-recommandé : arrêté" }).click();
  await expect(graphPanel.getByText("go-as-recommandé : en cours")).toBeVisible();
  await graphPanel.getByRole("button", { name: "arrêter" }).click();
  await expect(
    graphPanel.getByRole("button", { name: "go-as-recommandé : arrêté" }),
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
  // The one whose fieldset was filled in, named rather than counted: a second
  // repository was registered above, and the last of the list is that one.
  expect(projects.find((each) => each.path === repositoryRoot)?.verifyCommand).toBe("pnpm verify");

  // Leaving the settings comes back to the feature that was being watched: they
  // are a screen of their own, and their address carries no selection.
  await page.getByRole("button", { name: "revenir au pilotage" }).click();
  await expect(featuresPanel.getByRole("button", { name: /^Sans graphe/ })).toHaveAttribute(
    "aria-current",
    "true",
  );

  // The address says what is watched, so a reload lands back on it rather than
  // on the first feature of the list: the state comes from the server, the
  // selection from the URL.
  await page.getByRole("button", { name: /^Fondation/ }).click();
  await expect(page).toHaveURL(/\/projects\/[^/]+\/features\/[^/]+$/);
  const watched = page.url();
  await page.reload();
  await expect(page).toHaveURL(watched);
  await expect(nodes).toHaveCount(4);

  // A ticket has an address of its own, and squad serves its shell on it: this
  // is what a link left in an alert or a bookmark walks back into.
  await page.getByLabel("Le store, construction, prêt").click();
  const ticket = page.url();
  expect(ticket).toMatch(/\/tickets\/[^/]+$/);
  await page.goto(ticket);
  await expect(
    page.getByRole("region", { name: "Ticket" }).getByText("La base et ses migrations."),
  ).toBeVisible();

  // An address naming something squad does not have is corrected rather than
  // obeyed: the screen falls back on what it can show, and stops claiming the
  // rest.
  await page.goto("/projects/nexistepas/features/nonplus");
  await expect(page).toHaveURL(/\/projects\/[^/]+\/features\/[^/]+$/);
  await expect(page).not.toHaveURL(/nexistepas/);

  // The ground the interface is drawn on. It is a setting like the others, so
  // the click goes to the server and comes back on the event stream; and it
  // survives a reload, which is the only place the copy read before React
  // mounts is proven to be written and read.
  const root = page.locator("html");
  const themeSwitch = page.getByRole("group", { name: "Thème de l'interface" });
  await expect(root).not.toHaveAttribute("data-theme", /.*/);
  // The label rather than the radio, which is hidden under it: this is the
  // gesture a person makes.
  await themeSwitch.getByText("sombre").click();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(page.getByLabel("sombre")).toBeChecked();

  // Back to the browser's own setting, which writes no attribute at all: a
  // choice given back is not a third ground.
  await themeSwitch.getByText("système").click();
  await expect(root).not.toHaveAttribute("data-theme", /.*/);
});
