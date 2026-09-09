import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { realpath } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody, DirectoryListing } from "../../src/shared/api";
import { directoriesRoute } from "../../src/shared/api";
import { addOrigin, createTemporaryRepository, removeTemporaryPaths } from "../support/git";
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

  beforeEach(async () => {
    squad = await startTestSquad();
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

  it("says which of them are repositories", async () => {
    const root = await scratch();
    const repository = await createTemporaryRepository();
    await mkdir(join(root, "pas-un-depot"));
    // Moved under the walked directory rather than created there: the helper
    // makes a real repository, and this scenario needs one that is real.
    await mkdir(join(root, "un-depot"), { recursive: true });
    await writeFile(join(root, "un-depot", ".git"), `gitdir: ${repository}/.git\n`);

    const walked = await listing(root);

    const marked = Object.fromEntries(
      walked.entries.map((entry) => [entry.name, entry.isRepository]),
    );
    expect(marked).toEqual({ "pas-un-depot": false, "un-depot": true });
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
    const walked = await listing();
    expect(walked.path).toBe(await realpath(homedir()));
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
