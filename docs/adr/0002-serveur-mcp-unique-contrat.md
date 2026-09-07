# Le serveur MCP de squad est l'unique contrat avec les agents

Squad expose ses propres outils MCP aux sessions claude-code qu'il lance : rapport de fin
d'étape avec sa fiche de tests, question posée à l'utilisateur, création d'un ticket et de
ses arêtes. Tout ce qui remonte d'un agent passe par un appel d'outil au schéma validé,
jamais par du texte à interpréter.

## Pourquoi

Le schéma étant vérifié au moment de l'appel, un modèle qui produit une sortie malformée
est invité à recommencer sur-le-champ, au lieu de laisser squad découvrir le problème
après coup. Et un appel d'outil peut bloquer jusqu'à la réponse de l'utilisateur dans
l'interface, ce qui réalise directement l'exigence « poser des questions dans l'UI » sans
mécanisme séparé.

## Conséquences

Il n'existe et il ne doit exister aucun analyseur de prose dans le code de squad. Ce vide
est délibéré : le voir comme un manque et l'y ajouter reviendrait à défaire cette décision
et celle de l'ADR 0001.

Le contrat suppose que l'agent appelle effectivement l'outil de fin d'étape. Un filet est
nécessaire côté squad : détecter la fin du processus sans rapport reçu, et relancer la
demande explicitement plutôt que de conclure que le ticket est terminé.
