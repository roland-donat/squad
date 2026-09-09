import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody, DirectoryListing } from "../../src/shared/api";
import { directoriesRoute } from "../../src/shared/api";
import {
  addOrigin,
  createTemporaryRepository,
  removeTemporaryPaths,
  setOrigin,
} from "../support/git";
import { startTestSquad, type TestSquad } from "../support/squad";

/**
 * Choosing a repository by walking to it, rather than typing its absolute path
 * from memory. The walk is squad's own route and not the browser's file picker:
 * a `<input type="file" webkitdirectory>` hands back file names and never a real
 * path on disk, which is a guarantee of the browser rather than a detail. So the
 * browser still never touches the disk (ADR 0005), and squad reads for it.
 *
 * The route reads and nothing else: directory names, whether each is a
 * repository, and what a project registered there would be called.
 */
describe("walking to a repository", () => {
  let squad: TestSquad;
  const temporary: string[] = [];

  /** The home a walk with nothing to go on starts from, this scenario's own. */
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "squad-maison-")));
    temporary.push(home);
    // Handed in like the recorded conversations are, and for the same reason:
    // no test ever reads the home directory of whoever runs the suite.
    squad = await startTestSquad({ homeDir: home });
  });

  afterEach(async () => {
    // Made readable again first: a directory left unreadable cannot be removed.
    for (const path of temporary) await chmod(path, 0o755).catch(() => {});
    temporary.length = 0;
    await removeTemporaryPaths();
    await squad.dispose();
  });

  async function listing(path?: string): Promise<DirectoryListing> {
    const response = await squad.request("GET", directoriesRoute(path));
    expect(response.status).toBe(200);
    return (await response.json()) as DirectoryListing;
  }

  /** A directory built for one scenario, removed whatever the scenario does. */
  async function scratch(): Promise<string> {
    const path = await realpath(await mkdtemp(join(tmpdir(), "squad-walk-")));
    temporary.push(path);
    return path;
  }

  it("lists the directories of a directory, and never a file", async () => {
    const root = await scratch();
    await mkdir(join(root, "projets"));
    await mkdir(join(root, "archives"));
    await writeFile(join(root, "notes.md"), "pas un répertoire");

    const walked = await listing(root);

    expect(walked.path).toBe(root);
    expect(walked.entries.map((entry) => entry.name)).toEqual(["archives", "projets"]);
    expect(walked.entries.map((entry) => entry.path)).toEqual([
      join(root, "archives"),
      join(root, "projets"),
    ]);
  });

  it("says which of them are repositories, a worktree counting as one", async () => {
    const root = await scratch();
    await mkdir(join(root, "pas-un-depot"));
    await mkdir(join(root, "un-depot"));
    await mkdir(join(root, "un-depot", ".git"));
    // A worktree carries a `.git` file rather than a directory, and squad's own
    // worktrees are exactly that: the mark is read off the presence and not the
    // kind, which is what this second one is here to hold.
    await mkdir(join(root, "un-worktree"));
    await writeFile(join(root, "un-worktree", ".git"), "gitdir: /ailleurs/.git\n");

    const walked = await listing(root);

    const marked = Object.fromEntries(
      walked.entries.map((entry) => [entry.name, entry.isRepository]),
    );
    expect(marked).toEqual({
      "pas-un-depot": false,
      "un-depot": true,
      "un-worktree": true,
    });
  });

  it("carries the way back up, and stops at the root of the filesystem", async () => {
    const root = await scratch();
    await mkdir(join(root, "dedans"));

    const walked = await listing(join(root, "dedans"));
    expect(walked.parent).toBe(root);

    const top = await listing("/");
    expect(top.parent).toBeNull();
  });

  it("starts in the home directory when no path is named", async () => {
    await mkdir(join(home, "projets"));

    const walked = await listing();

    expect(walked.path).toBe(home);
    expect(walked.entries.map((entry) => entry.name)).toEqual(["projets"]);
  });

  it("walks through a symlink without losing the way back", async () => {
    const root = await scratch();
    const elsewhere = await scratch();
    await mkdir(join(elsewhere, "cible"));
    await symlink(elsewhere, join(root, "raccourci"));

    const walked = await listing(join(root, "raccourci"));

    // Where one clicked, not where the link points: a walk that stepped into a
    // link would land in a tree nobody asked for, and up would lead somewhere
    // they have never been. Making a path canonical is registration's business.
    expect(walked.path).toBe(join(root, "raccourci"));
    expect(walked.parent).toBe(root);
    expect(walked.entries.map((entry) => entry.name)).toEqual(["cible"]);
  });

  it("hands back what one step holds, and says how many there were", async () => {
    const root = await scratch();
    for (let index = 0; index < 12; index += 1) {
      await mkdir(join(root, `dossier-${String(index).padStart(2, "0")}`));
    }

    const walked = await listing(root);

    // The cap is far above twelve, so this says the count is the whole truth
    // when nothing is cut: a total that lied on a small directory would lie on
    // a large one too, where nobody could check it.
    expect(walked.total).toBe(12);
    expect(walked.entries).toHaveLength(12);
  });

  it("proposes the name the repository carries on its forge", async () => {
    const repository = await createTemporaryRepository();
    const remote = await addOrigin(repository);

    const walked = await listing(repository);

    expect(walked.isRepository).toBe(true);
    // The name of the remote rather than of the directory: a repository cloned
    // into `travail` is not a project called `travail`.
    expect(walked.suggestedName).toBe(basename(remote));
    expect(walked.suggestedName).not.toBe(basename(repository));
  });

  it.each([
    ["git@github.com:edgemind/muscadet.git", "muscadet"],
    ["https://github.com/edgemind/muscadet", "muscadet"],
    ["https://github.com/edgemind/muscadet.git/", "muscadet"],
    ["ssh://git@forge.interne:2222/edgemind/muscadet.git", "muscadet"],
    // Credentials in a remote are a real thing people have; what comes back is
    // the name and nothing of what stands before it.
    ["https://jeton@forge.interne/edgemind/muscadet.git", "muscadet"],
  ])("reads the name out of a remote written %s", async (url, expected) => {
    const repository = await createTemporaryRepository();
    await setOrigin(repository, url);

    const walked = await listing(repository);

    expect(walked.suggestedName).toBe(expected);
  });

  it("proposes the directory's name when the repository has no origin", async () => {
    const repository = await createTemporaryRepository();

    const walked = await listing(repository);

    expect(walked.isRepository).toBe(true);
    expect(walked.suggestedName).toBe(basename(repository));
  });

  it("proposes nothing outside a repository", async () => {
    const walked = await listing(await scratch());
    expect(walked.isRepository).toBe(false);
    expect(walked.suggestedName).toBeNull();
  });

  it("refuses a path that does not exist, saying which of the two it is", async () => {
    const response = await squad.request(
      "GET",
      directoriesRoute("/nexistepas-vraiment-pas/du-tout"),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("path_not_found");
  });

  it("refuses a path that is not a directory", async () => {
    const root = await scratch();
    await writeFile(join(root, "fichier.txt"), "pas un répertoire");

    const response = await squad.request("GET", directoriesRoute(join(root, "fichier.txt")));

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("invalid_request");
  });

  it("says an unreadable directory rather than emptying it, and the walk goes on", async () => {
    const root = await scratch();
    const closed = join(root, "interdit");
    await mkdir(closed);
    await chmod(closed, 0o000);
    temporary.push(closed);

    const response = await squad.request("GET", directoriesRoute(closed));
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("path_not_readable");

    // And the walk goes on: where one came from is still listed, the closed
    // directory among it, so the refusal costs a step and not the session.
    const walked = await listing(root);
    expect(walked.entries.map((entry) => entry.name)).toContain("interdit");
  });

  it("refuses a path that is not absolute", async () => {
    const response = await squad.request("GET", directoriesRoute("projets/relatif"));

    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe("invalid_request");
  });
});
