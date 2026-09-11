# Traiter un ticket est une modale, et la session principale est la barre de droite

Ouvrir un nœud du graphe n'ouvre plus un tiroir sur le bord droit de la carte : cela ouvre
une **modale** quasi plein écran, à deux onglets. L'onglet **Résumé** porte l'état en une
phrase, le décor de la feature replié, le contexte, la problématique, l'exemple, et
**l'action en attente** : la question posée, ou la fiche de tests à passer en revue.
L'onglet **Détail** porte la description complète, les critères d'acceptation, la
conclusion, le worktree et les questions déjà réglées. Une **colonne de conversation
permanente** longe la modale à droite, branchée sur la sous-session du ticket.

En contrepartie, le fil de la **session principale** quitte le tiroir du bas et devient
une **barre de droite repliable** sur l'écran de feature.

## Pourquoi

Cette décision **amende les ADR 0006 et 0007**, qui argumentent explicitement pour des
tiroirs couvrant la carte sans la redimensionner. Cet argument reste juste pour ce qu'il
visait : ouvrir un panneau ne doit pas défaire le cadrage que le lecteur vient de faire.
Il suppose seulement que regarder un ticket est un geste bref, pris au fil de la lecture
de la carte. C'est cette supposition qui est fausse.

Traiter un ticket n'est pas un coup d'œil. C'est répondre à une question, ou juger une
fiche de tests : le moment où la carte n'est plus l'affaire du lecteur. Un tiroir de
448 px a été mesuré portant environ 8 500 caractères (ADR 0009), ce qui fait quatre pages
dans une colonne étroite, à côté d'une carte qu'on ne regarde plus.

La modale le dit par sa forme : vous traitez ce ticket. Échap rend la carte.

**Deux surfaces auraient été pires qu'une.** Garder le tiroir pour le coup d'œil et
ajouter la modale pour le traitement, c'est deux rendus à maintenir pour la même chose et,
à chaque clic sur un nœud, la question de savoir lequel on va obtenir. Le rôle « coup
d'œil » est d'ailleurs déjà tenu par la carte, dont l'ADR 0006 dit qu'elle répond à « où en
est le chantier et à qui est le tour ».

**La largeur est la raison de la taille.** Il faut de la place pour deux onglets et une
colonne de conversation. Une modale bornée à 1 100 px, moins la colonne, laisse environ
700 px au contenu : le problème du tiroir déplacé de 250 px. D'où le quasi plein écran,
avec une marge qui garde le repère visuel qu'on est posé sur quelque chose.

**Deux conversations, deux endroits, et c'est délibéré.** La sous-session connaît le
worktree et le code du ticket ; la session principale détient le graphe. Les mélanger dans
une même barre obligerait à se demander à qui l'on parle avant chaque message. La modale
parle à la sous-session, la barre de droite à la session principale.

## Conséquences

L'adresse ne change pas : `/features/<f>/tickets/<t>` ouvre désormais la modale, si bien
qu'une alerte partie il y a trois jours atterrit directement là où ce qu'elle rapporte se
répond. **L'onglet n'est pas dans l'adresse** : tout ce qui se répond vit dans l'onglet
Résumé, qui est le défaut, donc aucune alerte n'aurait de raison de pointer Détail. Un
ticket sans résumé s'ouvre sur Détail, en le disant.

`?thread=open` **continue d'être lu** et déplie la barre de droite. Des alertes en portent,
et l'ADR 0007 pose que l'adresse est corrigée et jamais subie.

**Échap ferme toujours la modale**, y compris pendant la frappe d'un message, et le
brouillon est conservé par ticket dans le navigateur. Faire dépendre Échap du contenu du
champ rendrait son comportement imprévisible pour protéger ce qu'une conservation protège
mieux. Ce brouillon est une commodité, pas un réglage : il ne part jamais au serveur.

La colonne de conversation **suit l'état du ticket, et son bouton nomme toujours ce qui va
se passer** : on écrit et ça part quand une sous-session tourne ; le bouton dit « reprendre
avec ce message » sur un ticket arrêté, en conflit ou interrompu ; le champ est inerte sur
un ticket jamais lancé, où l'action offerte est de le lancer ; il n'y a pas de champ du tout
sur un ticket `decision`, qui se tranche dans la session principale, mais un lien qui y
mène. Écrire ne doit jamais ouvrir une sous-session à la frappe : cela prendrait une place
sous le plafond de concurrence et lancerait du travail sans que rien ne l'ait annoncé.
