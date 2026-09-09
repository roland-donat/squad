# Un seul plafond pour toutes les sessions que squad ouvre

Les sessions que squad ouvre pour un seul travail, le **dépouillement** d'une fiche de
tests et la **session de résolution** d'un conflit, entrent dans le même plafond de
concurrence que les sous-sessions qui construisent. Un ordonnanceur unique décide pour
les trois, ce qui attend une place s'écrit sur le ticket, et l'ordre de la file est
fixé.

Étend l'ADR 0003, qui ne parlait que des sous-sessions de tickets.

## Le trou

Ces deux sessions étaient ouvertes là où on en avait besoin, tenues chacune par un
compteur en mémoire qui lui était propre : `Settlements.running`, `Settlements.inFlight`,
`Merges.resolving`. Trois compteurs, dont aucun n'était un plafond, et invisibles à
l'ordonnanceur par construction : il ne lit que des états de ticket.

Constaté le 09/09/2026 sur l'instance réelle : dix fiches attendaient. Les dépouiller
depuis l'interface, en cliquant dix fois, aurait ouvert **dix sessions claude-code
simultanées**, chacune libre de lancer une suite de tests, sur une machine qui fait par
ailleurs tourner les sous-sessions du graphe. Le contournement du jour a été de les
enchaîner à la main par un script hors squad.

## Un plafond, pas deux

L'autre lecture était de leur donner un plafond propre, plus bas, au motif qu'elles ne
construisent rien. Écartée : la machine ne fait pas la différence entre une session qui
construit et une session qui dépouille, elles coûtent le même processus et la même suite
de tests.

L'argument qui plaidait pour un second plafond, qu'une passe attendant derrière une
sous-session longue retarde une fiche déjà écrite, est un argument de **priorité** et
non de plafond. Il est traité comme tel, par l'ordre de la file :

| Rang | Ce qui part | Pourquoi |
|---|---|---|
| 1 | résolution de conflit | elle retient la chaîne de fusion sérialisée de tout un projet |
| 2 | dépouillement | le travail est fait, une personne attend derrière |
| 3 | reprise d'une sous-session arrêtée | le travail est déjà sur sa branche |
| 4 | premier lancement | |

Un second plafond aurait ajouté un réglage à doser sans mesure, et la garantie qu'un
jour les deux seraient mal accordés.

**La session principale d'une feature n'est pas comptée.** C'est une conversation qu'on
ouvre soi-même, une par feature, inactive l'essentiel du temps : la compter ferait
refuser d'ouvrir la discussion qu'on cherche à avoir, et un plafond qui dit non à un
geste humain n'est pas un plafond, c'est une panne.

## Ce qui attend s'écrit sur le ticket

Trois colonnes, `service_job`, `service_queued_at` et `service_started_at`. Une file en
mémoire aurait été plus petite et aurait déplacé la vérité hors de la base : après un
redémarrage, plus personne ne saurait ce qui attendait, et « ce qui est en attente de
place se voit » n'aurait plus de source. C'est aussi la propriété que revendique l'ADR
0003, qu'un lancement oublié soit une propriété de l'état et non d'une décision perdue
quelque part.

Pas de table à part : les deux travaux portent déjà sur un ticket, et un ticket n'en
porte qu'un à la fois.

Deux états en découlent, `settling` et `settling-queued`, qui remplacent
`awaiting-validation` le temps de la passe. Ils disent aussi une chose que squad disait
faux : un ticket que squad dépouille **n'attend personne**, et le lister comme attendant
le développeur réveillait quelqu'un pour ce que squad allait répondre lui-même. La
résolution, elle, garde l'état `merging`, qui dit déjà que squad est dessus.

Au redémarrage, un dépouillement interrompu repart, borné par les deux tours qui
empêchent squad de s'argumenter avec lui-même ; une résolution est abandonnée, la fusion
qui en avait besoin étant reprise à part et redemandant sa place.

## Conséquences

`nextLaunches` ne rend plus des identifiants de tickets mais des couples `{ticketId,
job}` : le planificateur dit quoi ouvrir. La boucle qui ouvre ce qu'il a choisi vit dans
`dispatch.ts`, et non plus dans le module des sous-sessions, qui n'en était plus le
propriétaire légitime dès lors que trois sortes de session partagent un compte.

Le dépouillement demandé à la main répond toujours en face quand une place est libre,
ce qui est ce qu'on attend d'un clic ; les plafonds pleins, il répond que la passe
attend une place, et l'interface le dit plutôt que de tourner.
