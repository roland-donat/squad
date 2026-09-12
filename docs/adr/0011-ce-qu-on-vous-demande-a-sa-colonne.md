# Ce qu'on vous demande a sa colonne, et la conversation devient une bande

Dans la modale d'un ticket, ce qui attend une réponse quitte l'onglet Résumé et prend une
**colonne à lui**, à droite de ce qui se lit : la question posée, ou les points de la fiche
de tests qui attendent un verdict. La conversation avec la sous-session, qui longeait la
modale sur toute sa hauteur, devient une **bande sous les deux**, où le fil et le champ qui
écrit dedans sont côte à côte.

La colonne n'existe **que quand quelque chose attend**. Sinon la lecture prend toute la
largeur, comme avant.

Un **arbitrage arrive avec la route recommandée déjà prise**, et le bouton qui rend la fiche
est tenu au pied de la colonne. Une **vérification n'arrive cochée d'aucune façon**.

## Pourquoi

Cette décision **amende l'ADR 0010**, qui pose deux onglets et une colonne de conversation
permanente. Ce qu'elle garde : traiter un ticket n'est pas un coup d'œil, la modale le dit
par sa forme, et lire le résumé et répondre à la session qui l'a écrit est un seul geste.
Ce qu'elle corrige : l'ADR 0010 range « l'action en attente » dans l'onglet Résumé, à la
suite de tout ce qui s'y lit déjà.

Mesuré le 12/09/2026 sur le ticket 2e0e5ee3 d'une instance réelle, pour **un** arbitrage à
prendre : l'onglet portait 11 000 caractères avant d'y arriver, dont 6 700 de notes sur des
points que squad avait déjà réglés et que personne n'avait à juger. La décision elle-même
était sous la ligne de flottaison, sa route recommandée aussi.

**La preuve n'est pas le travail.** Ce que squad a mesuré est ce qui épargne de refaire la
mesure : indispensable, et consulté seulement quand une affirmation surprend. Déplié par
défaut, c'est le mur devant la seule chose à faire. D'où le repli, qui annonce combien de
points il tient.

**La présélection ne vaut que pour un arbitrage**, et c'est la seule ligne qui compte ici.
Un arbitrage est une route que squad a mesurée et recommande : c'est la réponse qu'il
prendrait lui-même en go-as-recommandé, donc être d'accord doit coûter un clic. Une
vérification demande d'avoir regardé quelque chose : une case précochée ferait signer d'un
clic un écran que personne n'a ouvert. Squad tient déjà les deux à part partout, dans le
typage de la passe, dans ce que le mode répond seul, et dans le refus d'une revue partielle
qui prendrait autre chose qu'un arbitrage. La forme le dit maintenant aussi.

**La bande plutôt qu'une troisième colonne.** Trois colonnes dans une modale bornée par la
fenêtre n'en laissent aucune lisible, et des trois c'est la conversation qu'on ouvre en
dernier. En bande, le fil et le champ se rangent côte à côte : sous la modale la largeur est
ce qu'il y a, et la hauteur est ce dont la fiche manque.

## Conséquences

**L'onglet n'est toujours pas dans l'adresse**, et pour une raison plus forte qu'avant : ce
qui se répond ne vit plus dans un onglet du tout. Une alerte qui pointe un ticket atterrit
sur ce qu'elle rapporte quel que soit l'onglet ouvert.

**L'action reste en vue pendant qu'on consulte le Détail.** C'était le mouvement que
l'ancienne disposition interdisait : aller lire la description faisait disparaître la fiche.

**Le bouton qui rend la fiche est collé au pied de la colonne.** Une recommandation fait
couramment sept cents caractères ; sans cela, être d'accord coûtait de dérouler la
justification de ce avec quoi on était d'accord.

Ce qui reste inchangé : Échap ferme toujours, le brouillon est conservé par ticket dans le
navigateur, et les deux conversations restent en deux endroits, la sous-session dans la
modale et la session principale dans la barre de droite de l'écran de feature.
