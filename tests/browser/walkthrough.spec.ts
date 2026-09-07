import { realpath } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { createTemporaryRepository, removeTemporaryPaths } from "../support/git";

test.afterAll(removeTemporaryPaths);

test("registers a project then opens a feature from the interface", async ({ page }) => {
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

  await expect(page.getByText("Fondation", { exact: true })).toBeVisible();

  // The state comes from the event stream, so it must survive a reload: that
  // proves it was written on the server rather than kept in the page.
  await page.reload();
  await expect(page.getByText("Fondation", { exact: true })).toBeVisible();
});
