# Exécution parallèle avec deux étages de fusion

Squad exécute simultanément tous les tickets de la frontière, dans la limite d'un plafond
de concurrence. Chaque ticket reçoit son propre worktree git et sa propre sous-session
vierge, sur une branche qui part de la branche de feature et y refusionne une fois validée ;
la branche de feature part ensuite vers la branche par défaut. L'ordonnancement est une
fonction déterministe du graphe, calculée par squad, jamais décidée par un agent.

## Pourquoi cette forme

Le graphe de dépendances ne vaut que s'il rend la frontière exploitable : une exécution
séquentielle le réduirait à une liste ordonnée. Deux étages de fusion sont ce qui donne aux
arêtes un sens opérationnel, un ticket bloqué ne partant qu'une fois son bloqueur fusionné.
Confier l'ordonnancement à un agent le rendrait non déterministe, coûteux en jetons, et
capable d'oublier un ticket en silence.

## Conséquences

Deux tickets verts séparément peuvent être rouges ensemble, ce qu'aucune sous-session ne
voit depuis son worktree. D'où la vérification d'intégration lancée sur la branche de
feature après chaque fusion, dont l'échec engendre un ticket de genre `fix` posé en
bloqueur de la suite.

Les fusions vers la branche par défaut sont sérialisées par dépôt, plusieurs features
pouvant être actives en même temps. Un conflit ouvre une session `/resolving-merge-conflicts`
avant toute escalade vers l'utilisateur.
