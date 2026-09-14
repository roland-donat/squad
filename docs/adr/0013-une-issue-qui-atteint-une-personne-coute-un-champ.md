# Une issue qui atteint une personne coûte un champ

La vérification préalable range chaque point d'une fiche dans une issue. Deux d'entre
elles sont réglées par une commande, `holds` et `broken`. Les deux autres sont ce à quoi
une personne sert, et **chacune coûte désormais un champ obligatoire** :

- un **arbitrage** (`decision`) doit nommer la **route** que la passe prendrait ;
- une **observation** (`observation`) doit nommer le **lieu** : quoi ouvrir, et quoi y
  regarder une fois ouvert.

Aucun des deux champs ne voyage avec l'autre issue, et une écriture qui s'y essaie est
refusée.

## Ce que ça remplace

Il y avait `human`, qui ne demandait rien. Un arbitrage devant nommer sa route, et une
remontée à l'humain ne devant rien, l'issue la moins chère était celle qui réveillait le
développeur : tout ce qu'une passe préférait ne pas juger y atterrissait.

Relevé le 14/09/2026 sur l'instance, sur les 35 points remontés depuis l'origine. Le compte
bouge à chaque fiche, c'est la proportion qui porte la décision :

| Ce que le point demandait | Nombre |
|---|---|
| ouvrir quelque chose que squad ne peut pas ouvrir (un écran, une instance déployée, un artefact rendu) | 5 |
| trancher une formulation, un nommage, un ordre de fusion, un message que lira un modélisateur | ~24 |
| signaler une remarque sur squad lui-même, faute d'un autre endroit où la mettre | ~6 |

Les trente derniers arrivaient chez le développeur comme des corvées, alors que la passe
avait lu le code et **avait** une opinion : elle n'avait pas de champ pour la dire, et
l'issue qui en demandait une coûtait plus cher que celle qui n'en demandait aucune.

Sur les cinq points qui attendaient le jour où la coupure a été écrite, un seul demandait
d'ouvrir quelque chose. Les quatre points arrivés pendant qu'elle se construisait étaient
tous les quatre des jugements, tranchés sans rien ouvrir.

## La ligne, et pourquoi c'est celle-là

La ligne n'est **pas** « la passe a-t-elle un avis », elle est « la passe avait-elle
**accès** ». Une passe a lu le code : sur une formulation, un nommage, un ordre, elle a une
route, et elle la doit. Ce qu'elle n'a pas, c'est un navigateur ouvert sur l'écran, une
instance déployée, un artefact rendu. Une passe qui ne sait pas nommer un lieu à ouvrir
n'est pas à court d'accès, elle est à court d'avis, et un avis est un arbitrage.

C'est cette ligne qui rend la coupure utile plutôt que cosmétique : un arbitrage est
**répondable par la machine**, puisque go-as-recommandé prend la route nommée (ADR 0012).
Une observation ne l'est pas et ne doit pas l'être. En basculant les jugements vers
l'arbitrage, la coupure ne déplace pas du travail d'une case à l'autre : elle le sort du
chemin du développeur.

## Pourquoi la route est refusée sur une observation

Une route posée sur une observation serait une réponse recommandée à propos d'un écran que
personne n'a ouvert. L'interface refusait déjà de pré-cocher une telle réponse ; la règle
est maintenant tenue par le contrat, là où un agent la lit, plutôt que par le rendu. C'est
la doctrine de l'ADR 0009 : les bornes sont déclarées dans le schéma, pas espérées d'une
consigne.

## Ce que ça coûte

Une valeur d'énumération renommée, une colonne, la migration `drizzle/0021` qui convertit
les `human` existants en `observation`, trois refus dans le store, les descriptions de
`settle_sheet`, la consigne de la passe et deux libellés d'interface.

La migration a été rejouée sur une copie de la base réelle avant d'être gardée, la suite de
tests ne pouvant pas l'attraper puisqu'elle part d'une base neuve : au 14/09/2026, 35 lignes
converties, notes conservées, les 115 arbitrages gardant leur route. Elle **efface** la route
et le périmètre des lignes qu'elle convertit : l'ancienne forme les tolérait sur un `human`,
la nouvelle les refuse sur une observation, et laisser une donnée qui viole l'invariant
qu'on vient de poser serait n'avoir posé qu'une intention. Aucune ligne n'en portait, ce qui
rend la clause gratuite aujourd'hui et juste demain.

## Ce qui n'est pas traité

Les ~6 remarques sur squad lui-même n'ont toujours pas d'endroit à elles. Elles entrent
dans l'une des deux issues sans forcer, et rien ne justifie une troisième valeur pour un
usage détourné : si elles reviennent, c'est un manque d'outil qu'il faudra nommer, pas une
issue de fiche.
