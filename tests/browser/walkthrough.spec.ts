import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { Feature, Project, Settings, Ticket } from "../../src/shared/api";
import {
  createTemporaryDirectory,
  createTemporaryRepository,
  removeTemporaryPaths,
} from "../support/git";
import { connectToSquadTools, writeTicket } from "../support/mcp";

test.afterAll(removeTemporaryPaths);

/** The name of the folder a repository lives in, which is what squad calls it. */
const nameOf = (path: string): string => path.split("/").at(-1) ?? "";

/**
 * Entering a feature opens a tab of its own, so the walk-through catches the
 * page the click created rather than following one that never moved.
 *
 * Waited on by its address rather than by its load: opening a feature holds the
 * tab open blank first, while the click that asked for it still counts, and
 * points it at the feature once there is one. A blank page has finished loading
 * the moment it exists, so that is not what says the tab is showing anything.
 */
async function enter(page: Page, name: RegExp): Promise<Page> {
  const [opened] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("button", { name }).click(),
  ]);
  await opened.waitForURL(/\/features\/[^/]/);
  return opened;
}

test("opens a feature from the home screen and reads the graph an agent wrote", async ({
  page,
  request,
  baseURL,
}) => {
  // In a directory of this run's own, and not straight in the system's
  // temporary one: the walk is capped, and a machine that has run this suite
  // has a temporary directory the repository would be lost in.
  const tree = await createTemporaryDirectory();
  const repository = await createTemporaryRepository(tree);
  // The server stores the path git reports, with its symlinks resolved.
  const repositoryRoot = await realpath(repository);

  // The home screen, on a squad that drives nothing yet: one gesture, and a
  // sentence saying what it opens.
  await page.goto("/");
  // Where the last walk ended, which is where the next one starts. Seeded so the
  // walk opens beside the repository this run made, rather than in the home
  // directory of whoever runs the suite: that squad starts there when nothing is
  // remembered is the seam suite's to prove, not this one's.
  //
  // Once, after the first load, and not on every one: an init script would
  // write it again at each reload, and the walk keeping where it was left would
  // then be impossible to tell from the seed doing it.
  await page.evaluate((from: string) => {
    window.localStorage.setItem("squad.last-directory", from);
  }, dirname(repositoryRoot));
  await expect(page.getByRole("heading", { name: "squad", exact: true })).toBeVisible();
  await expect(page.getByText("Aucune feature en vol.")).toBeVisible();

  // Opening a feature, and handing squad the repository in the same gesture:
  // there is nothing to do first, which is the point of the screen.
  await page.getByRole("button", { name: "Nouvelle feature" }).click();
  await expect(page).toHaveURL(/\/features\/new$/);
  await page.getByLabel("Un dépôt que squad ne pilote pas encore").check();

  // Walked to rather than typed: squad serves the walk, since a browser's own
  // directory picker hands back file names and never a real path on disk.
  await page.getByRole("button", { name: "Parcourir" }).click();
  const walk = page.getByRole("dialog", { name: "Choisir un dépôt" });
  await expect(walk.getByText(dirname(repositoryRoot), { exact: true })).toBeVisible();
  await walk.getByRole("button", { name: nameOf(repositoryRoot) }).click();
  // The repository says so before it is chosen, which is the whole point of
  // walking rather than typing.
  await expect(walk.getByText("dépôt git").first()).toBeVisible();
  await walk.getByRole("button", { name: "Choisir ce répertoire" }).click();

  // The path is filled in full, and the name proposed from the repository: this
  // one has no origin, so its own directory names it.
  await expect(page.getByLabel("Chemin du dépôt")).toHaveValue(repositoryRoot);
  await expect(page.getByLabel("Nom du dépôt (facultatif)")).toHaveValue(nameOf(repositoryRoot));

  await page.getByLabel("Intitulé de la feature").fill("Fondation");
  // The one setting the screen puts forward, and says why.
  await expect(page.getByText(/seul filet qui attrape/)).toBeVisible();
  await page.getByLabel("Commande de vérification").fill("pnpm verify");
  const work = await enter(page, /^Ouvrir la feature$/);

  // The feature has its own tab, named after itself, and the home screen it was
  // opened from is still there behind it.
  await expect(work).toHaveURL(/\/features\/[^/?]+(\?thread=open)?$/);
  await expect(work.getByRole("heading", { name: "Fondation" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  expect(await work.evaluate(() => window.name)).toMatch(/^squad-feature-/);

  // The graph is empty, so the drawer of the main session is open: pasting the
  // spec and asking for the breakdown is the whole business of the feature now.
  const thread = work.getByRole("region", { name: "Session principale" });
  await expect(thread.getByText("Fil vide.")).toBeVisible();
  await expect(thread.getByRole("button", { name: "Ouvrir la session principale" })).toBeVisible();
  // The shortcuts of the main session, not clicked here: doing so would open a
  // real claude-code session, which this walk-through never does.
  await expect(thread.getByRole("button", { name: "/to-spec" })).toBeVisible();
  await expect(thread.getByRole("button", { name: "/to-tickets" })).toBeVisible();

  // The graph is written by an agent through squad's tools, never by the
  // interface: the walk-through writes it the way an agent would.
  const listed = await request.get("/api/features");
  const { features } = (await listed.json()) as { features: Feature[] };
  const feature = features.at(-1);
  if (!feature) throw new Error("the feature just opened is missing from the API");

  const tools = await connectToSquadTools(baseURL ?? "");
  const store = (await writeTicket(tools, {
    featureId: feature.id,
    kind: "build",
    title: "Le store",
    description: "La base et ses migrations.",
  })) as Ticket;
  const mcp = (await writeTicket(tools, {
    featureId: feature.id,
    kind: "build",
    title: "Les outils MCP",
    description: "Le contrat avec les agents.",
    blockedBy: [store.id],
  })) as Ticket;
  await writeTicket(tools, {
    featureId: feature.id,
    kind: "decision",
    title: "Quelle disposition",
    description: "À trancher.",
    blockedBy: [mcp.id],
  });
  // Nothing blocks this one, so it is waiting on the developer right now: it is
  // what the indicator has to list.
  await writeTicket(tools, {
    featureId: feature.id,
    kind: "decision",
    title: "Quelle base",
    description: "SQLite ou autre.",
  });
  await tools.close();

  // Four nodes and the two arrows between them, without a reload: the graph
  // arrives on the event stream while it is being written.
  const nodes = work.getByRole("region", { name: "Graphe" }).locator(".node");
  await expect(nodes).toHaveCount(4);
  await expect(work.getByLabel("Le store, construction, prêt")).toBeVisible();
  await expect(work.getByLabel("Les outils MCP, construction, bloqué")).toBeVisible();
  await expect(work.getByLabel("Quelle disposition, décision, bloqué")).toBeVisible();
  await expect(work.locator(".graph__edge")).toHaveCount(2);

  // The drawer squad opened on an empty graph folds away by itself now that
  // there is a graph to look at, and the address is what says so.
  await expect(work).not.toHaveURL(/thread=open/);
  await expect(thread).toBeHidden();

  // Placing it is what takes it out of squad's hands, and the address carries
  // that too: this is what an alert about a question of the main session links
  // to, and it is not folded away under whoever followed it.
  await work.getByRole("button", { name: /Session principale/ }).click();
  await expect(work).toHaveURL(/thread=open/);
  await expect(thread).toBeVisible();
  await work.getByRole("button", { name: /Session principale/ }).click();
  await expect(work).not.toHaveURL(/thread=open/);

  // The map is navigated rather than scrolled: the wheel zooms, and the key
  // that recentres puts it back exactly where the framing had left it.
  const map = work.locator(".graph");
  const framing = () => map.evaluate((element) => element.style.transform);
  // Framed first, so what is compared to is a framing of what is visible now:
  // the drawer was just closed, and a map nobody has placed follows that.
  await work.locator(".graph__viewport").focus();
  await work.keyboard.press("0");
  const framed = await framing();
  await work.locator(".graph__viewport").hover();
  await work.mouse.wheel(0, -300);
  await expect.poll(framing).not.toBe(framed);
  await work.locator(".graph__viewport").focus();
  await work.keyboard.press("0");
  await expect.poll(framing).toBe(framed);

  // One tab stop for the whole map, whatever it holds: the arrows walk from
  // node to node inside it.
  await expect(work.locator(".node[tabindex='0']")).toHaveCount(1);

  // The indicator lists what waits on the developer in this feature, and opens
  // it: the decision nothing blocks is there, the one still blocked is not.
  const waiting = work.getByRole("region", { name: "Actions en attente" });
  await expect(waiting.getByRole("button")).toHaveCount(1);
  const entry = waiting.getByRole("button", { name: /Quelle base/ });
  await expect(entry).toContainText("décision à trancher");
  await entry.click();
  await expect(
    work.getByRole("region", { name: "Ticket" }).getByText("SQLite ou autre."),
  ).toBeVisible();

  // Clicking a node opens the ticket: what it asks for, and the thread of the
  // sub-session that will build it. Nothing is launched here, since this
  // walk-through runs against the real launcher.
  await work.getByLabel("Le store, construction, prêt").click();
  const opened = work.getByRole("region", { name: "Ticket" });
  await expect(opened.getByText("La base et ses migrations.")).toBeVisible();
  await expect(opened.getByText("Aucune sous-session pour l'instant.")).toBeVisible();
  await expect(opened.getByRole("button", { name: "Lancer le ticket" })).toBeVisible();

  // A blocked ticket offers no launch: the arrows of the graph mean something.
  await work.getByLabel("Les outils MCP, construction, bloqué").click();
  await expect(opened.getByRole("button", { name: "Lancer le ticket" })).toBeHidden();

  // The panel is the selection: closing it deselects, and there is no second
  // state left behind claiming a ticket is open.
  await opened.getByRole("button", { name: "fermer" }).click();
  await expect(opened).toBeHidden();
  await expect(work).toHaveURL(/\/features\/[^/?]+$/);

  // The address says what is watched, so a reload lands back on it. A ticket has
  // an address of its own, and squad serves its shell on it: this is what a link
  // left in an alert or a bookmark walks back into.
  await work.getByLabel("Le store, construction, prêt").click();
  const ticketAddress = work.url();
  expect(ticketAddress).toMatch(/\/features\/[^/]+\/tickets\/[^/?]+$/);
  await work.goto(ticketAddress);
  await expect(opened.getByText("La base et ses migrations.")).toBeVisible();

  // An address of the shape squad used to write is still read: alerts carrying
  // it have been sent, and they are opened days later.
  await work.goto(`/projects/nimporte/features/${feature.id}?thread=open`);
  await expect(work).toHaveURL(`/features/${feature.id}?thread=open`);
  await expect(thread).toBeVisible();

  // An address naming a feature squad does not have goes back to the home
  // screen and says why, rather than quietly landing on another piece of work.
  await work.goto("/features/nexistepas");
  await expect(work).toHaveURL(/\/$/);
  await expect(work.getByText(/n'existe plus/)).toBeVisible();
  await work.close();

  // Back on the home screen: the feature is listed with how far it has come and
  // what waits on it, and the tab title carries that count.
  await page.reload();
  const row = page.getByRole("button", { name: /^Fondation/ });
  await expect(row).toContainText("0 ticket");
  await expect(row).toContainText(nameOf(repositoryRoot));
  await expect(page.getByRole("button", { name: /^Fondation/ })).toContainText("1");
  await expect.poll(() => page.title()).toMatch(/^\(1\) squad$/);

  // A second repository and a feature carrying both: the map then says on every
  // node which one builds it, since the answer stops being the same everywhere.
  const second = await createTemporaryRepository();
  await page.getByRole("button", { name: "Nouvelle feature" }).click();
  await page.getByLabel("Un dépôt que squad ne pilote pas encore").check();
  await page.getByLabel("Chemin du dépôt").fill(second);
  await page.getByLabel("Intitulé de la feature").fill("Sur deux dépôts");
  // By role, the home repository being offered twice on this screen: once as
  // the repository to hang the feature on, once as one it may also touch.
  await page.getByRole("checkbox", { name: nameOf(repositoryRoot) }).check();
  const across = await enter(page, /^Ouvrir la feature$/);

  // The settings fields are about the repository they are shown for, and about
  // no other: this feature hangs on a repository squad had never seen, so it
  // must not have inherited the verification command of the one listed first.
  const { projects: afterSecond } = (await (await request.get("/api/projects")).json()) as {
    projects: Project[];
  };
  expect(afterSecond.find((each) => nameOf(each.path) === nameOf(second))?.verifyCommand).toBe(
    null,
  );

  const withBoth = await request.get("/api/features");
  const { features: carried } = (await withBoth.json()) as { features: Feature[] };
  const carrying = carried.at(-1);
  if (!carrying) throw new Error("the feature just opened is missing from the API");
  const both = await connectToSquadTools(baseURL ?? "");
  await writeTicket(both, {
    featureId: carrying.id,
    kind: "build",
    title: "Ici",
    description: "Dans le dépôt d'attache.",
  });
  await writeTicket(both, {
    featureId: carrying.id,
    projectId: carrying.repositories[1]?.projectId,
    kind: "build",
    title: "Là-bas",
    description: "Dans l'autre dépôt.",
  });
  await both.close();

  await expect(across.getByLabel(`Ici, construction, prêt, ${nameOf(second)}`)).toBeVisible();
  await expect(
    across.getByLabel(`Là-bas, construction, prêt, ${nameOf(repositoryRoot)}`),
  ).toBeVisible();
  await expect(across.locator(".app__header")).toContainText(nameOf(repositoryRoot));
  await across.close();

  // Go-as-recommandé, in the header of the tab it drives. It is armed on a
  // feature whose graph is empty, so squad has nothing to launch and this
  // walk-through opens no session: what is proven is the control, not the
  // drain, which the seam covers with a scripted agent.
  await page.getByRole("button", { name: "Nouvelle feature" }).click();
  await page.getByLabel("Intitulé de la feature").fill("Sans graphe");
  const idle = await enter(page, /^Ouvrir la feature$/);
  const header = idle.locator(".app__header");
  await header.getByRole("button", { name: "go-as-recommandé : arrêté" }).click();
  await expect(header.getByText("go-as-recommandé : en cours")).toBeVisible();
  await header.getByRole("button", { name: "arrêter" }).click();
  await expect(header.getByRole("button", { name: "go-as-recommandé : arrêté" })).toBeVisible();
  await idle.close();

  // Resuming a conversation, which is where a feature comes from when it comes
  // from work already done. What is on this machine is nobody's business here:
  // what is proven is that the picker asks squad and renders the answer, so the
  // search is given something nothing can match.
  await page.getByRole("button", { name: "Nouvelle feature" }).click();
  await page.getByLabel("Reprendre une conversation claude-code").check();
  await page.getByLabel("Rechercher une conversation").fill("zzz-aucune-conversation-zzz");
  await expect(page.getByText("Aucune conversation ne correspond.")).toBeVisible();
  await page.getByRole("button", { name: "revenir à l'accueil" }).click();

  // The settings screen: what squad is configured with, and where a repository
  // is handed over when one is not opening a feature at the same time.
  await page.getByRole("button", { name: "réglages" }).click();
  const machine = page.getByRole("region", { name: "Réglages de la machine" });
  await machine.getByLabel("Profondeur d'engendrement maximale").fill("2");
  await machine.getByRole("button", { name: "Enregistrer les réglages" }).click();
  await expect(machine.getByText("Enregistré.")).toBeVisible();

  const ofProject = page.getByRole("group", { name: nameOf(repositoryRoot) });
  await ofProject.getByLabel("Branche par défaut").fill("main");
  await ofProject.getByRole("button", { name: "Enregistrer le projet" }).click();
  await expect(ofProject.getByText("Enregistré.")).toBeVisible();

  // The same walk on this project's own path, which is the one time it is typed
  // a second time, and typing it wrong sends squad's branches into another
  // repository. This project's form and no other: the registration form above
  // has a walk of its own, and hitting that one would prove nothing about this.
  await ofProject.getByRole("button", { name: "Parcourir" }).click();
  const again = page.getByRole("dialog", { name: "Choisir un dépôt" });
  // Opened where the last walk ended, which is what says the choice was kept:
  // the creation screen walked to this repository at the start of this run.
  await expect(again.getByText(repositoryRoot, { exact: true })).toBeVisible();
  await again.getByRole("button", { name: ".. remonter" }).click();
  await expect(again.getByText(dirname(repositoryRoot), { exact: true })).toBeVisible();
  await again.getByRole("button", { name: "Choisir ce répertoire" }).click();
  // Filled in, and only in this project's form. Not submitted: what is proven
  // here is the walk, and changing where squad thinks this repository lives
  // would send everything after this line somewhere else.
  await expect(ofProject.getByLabel("Chemin du dépôt")).toHaveValue(dirname(repositoryRoot));

  // Held by the server, not by the screen: what was typed is what squad
  // applies, and the verification command set on the creation screen took.
  const { settings } = (await (await request.get("/api/settings")).json()) as {
    settings: Settings;
  };
  expect(settings.generationDepthCap).toBe(2);
  const { projects } = (await (await request.get("/api/projects")).json()) as {
    projects: Project[];
  };
  expect(projects.find((each) => each.path === repositoryRoot)?.verifyCommand).toBe("pnpm verify");

  // Leaving the settings comes back where one was: they are a screen of their
  // own, and their address carries no selection.
  await page.getByRole("button", { name: "revenir" }).click();
  await expect(page).toHaveURL(/\/$/);

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
