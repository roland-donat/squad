import { expect, test } from "@playwright/test";
import { createTemporaryRepository } from "../support/git";

test("enregistre un projet puis ouvre une feature depuis l'interface", async ({ page }) => {
  const repository = await createTemporaryRepository();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "squad" })).toBeVisible();

  await page.getByLabel("Chemin du dépôt").fill(repository);
  await page.getByRole("button", { name: "Enregistrer le projet" }).click();

  await expect(page.getByText(repository, { exact: true })).toBeVisible();

  await page.getByLabel("Intitulé de la feature").fill("Fondation");
  await page.getByRole("button", { name: "Ouvrir la feature" }).click();

  await expect(page.getByText("Fondation", { exact: true })).toBeVisible();

  // L'état vient du flux d'événements : il doit survivre à un rechargement,
  // donc avoir été écrit côté serveur et non gardé dans la page.
  await page.reload();
  await expect(page.getByText("Fondation", { exact: true })).toBeVisible();
});
