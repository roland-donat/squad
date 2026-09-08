<img src="src/ui/brand/squad-lockup.svg" alt="squad" width="216" />

**SQUAD is Shut up, Queue up, Unblock, Assemble, Deliver.**

Poste de pilotage local pour agents claude-code. Squad détient le plan d'exécution
d'une feature sous forme de graphe, lance les sessions qui construisent chaque
tranche, et rend à l'utilisateur les seules décisions qu'il ne peut pas déléguer.

## Démarrer

```bash
pnpm install
pnpm dev
```

L'interface est alors servie sur <http://127.0.0.1:7300>, par le même serveur que
l'API. Enregistrer un projet en donnant le chemin d'un dépôt git, puis y ouvrir une
feature.

L'état vit sous `~/.local/share/squad`, jamais dans un dépôt piloté ;
`SQUAD_DATA_DIR` et `SQUAD_PORT` permettent de le déplacer.

## Vérifier

```bash
pnpm verify         # typage et tests au seam
pnpm test:browser   # parcours navigateur
```

Le vocabulaire du domaine est dans [`CONTEXT.md`](CONTEXT.md), les décisions
d'architecture dans [`docs/adr/`](docs/adr/), les consignes de développement dans
[`CLAUDE.md`](CLAUDE.md).
