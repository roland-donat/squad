# Trois écrans, et un onglet par feature

Squad n'est plus une page. L'accueil (`/`) liste les features à plat, tous dépôts
confondus. La création (`/features/new`) ouvre un chantier, de rien ou d'une
conversation claude-code déjà menée. Une feature (`/features/<f>`) a **son propre
onglet de navigateur**, nommé d'après elle. Les réglages (`/settings`) restent un
écran à part.

Le projet n'est plus un niveau de navigation. L'adresse d'une feature ne le nomme
plus, et l'écran qui obligeait à choisir un dépôt avant de voir le moindre travail
a disparu.

## Pourquoi

La page unique portait tout à la fois : le travail, la liste des features, la liste
des projets et les trois formulaires qui les mettent en place. Ce qu'on fait une
fois par dépôt et ce qu'on fait toute la journée s'y disputaient le même écran, et
l'ADR 0006 avait déjà commencé à les séparer en poussant la mise en route dans des
dialogues. Découper par question posée finit le travail : où aller, quoi ouvrir, où
en est ce chantier, avec quoi squad est réglé.

**Un onglet par feature** parce que squad pilote plusieurs chantiers de front et
qu'un chantier se suit dans la durée : le navigateur sait déjà tenir plusieurs
choses ouvertes, et refaire cette gestion à l'intérieur d'une page reviendrait à
réécrire des onglets moins bons que les siens. L'onglet est **nommé**
(`squad-feature-<id>`), donc entrer deux fois dans la même feature depuis l'accueil
ramène l'onglet qui la montre au lieu d'en ouvrir un second, avec un second flux
d'événements.

**Le projet cesse d'être un niveau** parce qu'il n'en a jamais vraiment été un : une
feature porte plusieurs dépôts, donc la ranger sous l'un d'eux était déjà une
approximation, et choisir un projet ne décidait rien.

## Ce que ça coûte

**Le nommage d'onglet ne tient pas depuis une alerte.** Un navigateur ne retrouve un
onglet par son nom qu'à l'intérieur du groupe de contextes d'où il a été ouvert. Un
lien cliqué dans une conversation Google Chat ou dans une notification de bureau
atterrit dans un groupe à lui, et n'y retrouve rien. `claimTabName`, qui fait
revendiquer son nom à l'onglet d'une feature quelle que soit son origine, réduit
l'écart sans le fermer. C'est une limite du navigateur, pas un choix.

**Les adresses changent, et le serveur en écrit.** Une alerte porte l'adresse de ce
dont elle parle, et elle se lit sur un téléphone des jours plus tard. La forme
`/projects/<p>/features/<f>` est donc **toujours lue**, le segment de projet étant
traversé sans être honoré, et l'adresse est réécrite dans sa forme actuelle une fois
la page chargée. C'est ce qui rend le changement réversible sans casser ce qui est
déjà parti.

**Une feature inconnue renvoie à l'accueil, en le disant.** L'ancien repli, montrer
la première feature venue, devient dangereux avec un onglet par chantier : on clique
une alerte sur un travail et on atterrit sur un autre, sans que rien ne le signale.

## L'écran de travail

La coque de l'ADR 0006 ne bouge pas : hauteur fixe, aucun défilement de page, chaque
panneau défilant chez lui. Ce qui change est ce qu'elle contient.

Les **actions en attente** listées à gauche sont désormais celles de **cette feature
seulement**. La vue globale, que le glossaire définit comme « toutes features
confondues », remonte sur l'accueil, qui est l'écran où l'on décide où aller ; un
onglet dédié à un chantier qui listerait les blocages de trois autres rejouerait le
fourre-tout qu'on supprime.

La **session principale** descend dans un tiroir le long du bas, et le panneau du
**ticket** garde le bord droit. Les deux étaient auparavant exclusifs dans le même
tiroir de droite, si bien qu'une question posée sur la session principale était
inatteignable tant qu'un ticket était ouvert. Les deux tiroirs se **superposent** à
la carte plutôt que de lui prendre une colonne et une ligne, exactement pour la
raison que donne l'ADR 0006 : ouvrir un panneau ne doit pas redimensionner le
viewport, sans quoi le cadrage qu'on vient de faire serait défait par le clic même
qui en avait besoin. Ce qu'ils masquent est déclaré à la carte, qui ramène un nœud
couvert par une translation, sans toucher à l'échelle.

Le tiroir du fil est ouvert tant que le graphe est vide, fermé ensuite : une feature
sans graphe n'a que son fil pour objet. Il **ne s'ouvre jamais tout seul** quand une
question arrive ; l'agent bloqué lève déjà une alerte et figure déjà dans la liste
d'attente, et déplacer la moitié de l'écran sous quelqu'un qui lit un rapport
d'étape ne gagnerait rien.

Son ouverture vit dans l'adresse, en paramètre de requête (`?thread=open`) et non en
segment de chemin : le tiroir est orthogonal au ticket ouvert, les deux peuvent
l'être en même temps, ce qu'un chemin ne saurait pas dire. C'est ce qui permet à une
alerte portant sur une question de la session principale de pointer un endroit où
cette question se répond vraiment.

Sous 1180 px, la colonne d'attente sort de la rangée et se pose sur la carte, ouverte
par un bouton de l'en-tête. Trois zones et un tiroir ne tiennent pas côte à côte sur
un portable, et les empiler reviendrait à renoncer à la hauteur fixe.

## Ce qui n'est pas un réglage

La largeur du panneau de ticket et la hauteur du tiroir sont retenues dans le
navigateur (`localStorage`), jamais en base. Le thème y est, lui, parce que squad
le lit : il décide de ce que la page peint avant que React ne monte. Une largeur de
panneau ne décide de rien que squad fasse, et diffère légitimement d'une fenêtre à
l'autre ; la tenir en un seul endroit ferait se disputer deux fenêtres de tailles
différentes.

## Ce qui reste ouvert

Aucun état de cycle de vie n'a été ajouté à une feature. « En vol » et « livrée » se
lisent sur le graphe, `isDrained` étant la même règle qui décide de ce que squad
envoie en pull request. Archiver une feature abandonnée mais non drainée est une
fonctionnalité qu'on n'a pas construite, et qui se posera le jour où une telle
feature traînera en haut de la liste.

Le tri de l'accueil met en tête ce qui attend le plus, puis les plus récemment
ouvertes. Une vraie date de dernière activité demanderait une colonne touchée par
tous les chemins d'écriture ; la dériver des tickets mentirait, une sous-session qui
tourne depuis deux heures sans écrire de ticket ne déplaçant rien.
