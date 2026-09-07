# Un serveur unique sert l'API et l'interface

Squad est un processus Node qui détient la base, expose l'API HTTP, émet le flux
d'événements et sert l'interface. En développement, il monte Vite en mode intergiciel
plutôt que de laisser Vite tenir son propre serveur ; en production, il sert le contenu
de `dist/ui`. Dans les deux cas, l'interface et l'API partagent une seule origine et un
seul port, et une seule commande démarre le tout.

## Pourquoi

Le montage usuel, Vite sur un port et le serveur sur un autre avec un proxy `/api`,
introduit un chemin de requête qui n'existe qu'en développement. Ce que les tests
navigateur observent n'est alors pas ce que l'utilisateur exécute : l'origine diffère,
le proxy tamponne, et le flux d'événements est précisément ce qu'un proxy mal réglé
casse en premier. Une origine unique supprime la question, et avec elle le CORS.

Le coût est que le serveur importe Vite en développement. L'import est paresseux et
n'est jamais atteint en production, où Vite reste une dépendance de développement.

## La pile qui en découle

| Couche | Choix | Ce qui a été écarté |
|---|---|---|
| Serveur HTTP | Express 5 | Hono, qui n'accepte pas directement les intergiciels connect de Vite |
| Base | SQLite via `better-sqlite3` | `node:sqlite`, qu'aucun pilote Drizzle ne prend en charge |
| Schéma et migrations | Drizzle ORM et drizzle-kit | SQL écrit à la main, qui ne rend pas les types au reste du code |
| Interface | React 19 et Vite | rien de sérieusement envisagé, le graphe à venir demande un rendu réactif |
| Validation | Zod 4 | les mêmes schémas serviront aux outils MCP, dont le contrat doit être validé |
| Tests au seam | Vitest | |
| Test navigateur | Playwright | |

## Conséquences

Le port par défaut est unique et vaut pour tout : interface, API et flux d'événements.
Un test au seam démarre le serveur avec `ui: "none"`, ce qui évite de payer le coût de
Vite dans une suite qui ne regarde jamais une page.

L'état durable vit sous le répertoire de données de l'utilisateur, résolu depuis le
domicile de l'utilisateur et jamais depuis le répertoire courant, de sorte que squad
lancé depuis un dépôt qu'il pilote n'y écrit rien. L'enregistrement d'un projet refuse
d'ailleurs un dépôt qui contiendrait ce répertoire.
