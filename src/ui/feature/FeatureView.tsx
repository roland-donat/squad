import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Feature } from "../../shared/api";
import { pendingActions, type PendingAction } from "../../shared/pending";
import { ticketsAwaitingDeveloper } from "../../shared/state-family";
import { feature as featureRoute, home, type FeatureRoute } from "../../shared/ui-routes";
import { Brand, Connection, ThemeSwitch } from "../chrome";
import { useDragSize, useMediaQuery, useStoredSize } from "../geometry";
import { FeatureGraphView } from "../graph/FeatureGraphView";
import { navigate } from "../route";
import { MainSessionView } from "../session/MainSessionView";
import { claimTabName } from "../tab";
import { TicketPanel } from "../ticket/TicketPanel";
import {
  featureQuestionsOf,
  graphOf,
  isMainSessionRunning,
  threadOf,
  ticketQuestionsOf,
  ticketThreadOf,
  type SquadState,
} from "../useSquadState";
import { AutonomySwitch } from "./AutonomySwitch";
import { WaitingPanel } from "./WaitingPanel";

/**
 * One feature, in a tab of its own: what waits on it down the left, the map it
 * waits in taking everything else, the ticket a node opens laid over the map's
 * right edge, and the feature's own thread in a drawer along the bottom.
 *
 * Both drawers lie over the map rather than taking a column and a row from it.
 * That is what ADR 0006 asks for: opening one must not resize the viewport, or
 * the framing the reader has just made would be undone by the very click that
 * needed it. What they cover is handed to the map instead, which translates a
 * node back out from underneath without touching the scale.
 */

/** Below this, the waiting column steps out of the row and onto the map. */
const narrowScreen = "(max-width: 1180px)";

export function FeatureView({
  state,
  route,
  feature,
}: {
  state: SquadState;
  route: FeatureRoute;
  feature: Feature;
}) {
  const graph = graphOf(state, feature.id);
  // Read back from the graph at every render rather than held in state: a ticket
  // that changes while its panel is open must show the change, and the panel
  // must close itself if the ticket leaves the graph.
  const openedTicket = graph.tickets.find((ticket) => ticket.id === route.ticketId) ?? null;
  // This feature and no other. What waits everywhere at once is read on the home
  // screen, which is the screen one opens to decide where to go.
  const waiting = pendingActions(state.graphs, state.questions).filter(
    (action) => action.featureId === feature.id,
  );

  // This tab is this feature's tab, whichever way it came to exist: entering the
  // same feature again from the home screen then finds it rather than opening a
  // second tab on the same graph.
  useEffect(() => claimTabName(feature.id), [feature.id]);

  const go = (selection: { ticketId?: string | null; threadOpen?: boolean }) =>
    navigate(
      featureRoute(feature.id, {
        ticketId: selection.ticketId === undefined ? route.ticketId : selection.ticketId,
        threadOpen: selection.threadOpen === undefined ? route.threadOpen : selection.threadOpen,
      }),
    );

  // The drawer is open while there is nothing else to look at, and closed once
  // there is. A feature whose graph is empty is a feature whose whole business
  // is its thread: the spec is pasted there and the breakdown asked for there.
  // Applied once per feature and per tab, so closing it is not undone at the
  // next render, and the address stays what says where the drawer stands.
  const defaulted = useRef<string | null>(null);
  useEffect(() => {
    if (!state.loaded || defaulted.current === feature.id) return;
    defaulted.current = feature.id;
    if (graph.tickets.length === 0 && !route.threadOpen) {
      navigate(featureRoute(feature.id, { ticketId: route.ticketId, threadOpen: true }), {
        replace: true,
      });
    }
  }, [state.loaded, feature.id, graph.tickets.length, route.ticketId, route.threadOpen]);

  /** Opens what an entry of the waiting list points at, wherever it lives. */
  function open(action: PendingAction) {
    // A question the main session asked hangs on no ticket: what it is answered
    // in is the feature's own thread, so the drawer is what has to open.
    if (action.ticketId === null) go({ ticketId: null, threadOpen: true });
    else go({ ticketId: action.ticketId });
  }

  // The repositories the feature carries, named: the map and the ticket panel
  // both say which one a ticket is built in, and both read this.
  const repositoryNames = new Map(
    feature.repositories.map((carried) => [
      carried.projectId,
      state.projects.find((project) => project.id === carried.projectId)?.name ?? "dépôt inconnu",
    ]),
  );

  const [ticketWidth, setTicketWidth] = useStoredSize("squad.ticket-width", 448);
  const [threadHeight, setThreadHeight] = useStoredSize(
    // Kept per feature: how much room a thread needs is a property of the piece
    // of work being talked about, not of the browser.
    `squad.thread-height.${feature.id}`,
    // A share of the window rather than a number of pixels: the drawer holds a
    // conversation and the box one writes into, and a height that fits a large
    // screen leaves the send button off a laptop.
    Math.max(320, Math.round(window.innerHeight * 0.44)),
  );
  // What each drawer hides of the map, so the map can bring a covered node back
  // into what is left. In pixels, because that is what the viewport works in.
  const obstructedRight = openedTicket === null ? 0 : ticketWidth;
  const obstructedBottom = route.threadOpen ? threadHeight : 0;

  const narrow = useMediaQuery(narrowScreen);
  const [waitingOpen, setWaitingOpen] = useState(false);
  // Folded away by the window rather than by a click: a column shown as an
  // overlay must not stay open over the map once the window is wide again.
  useEffect(() => {
    if (!narrow) setWaitingOpen(false);
  }, [narrow]);

  // Escape gives the map back: whatever is open over it closes. Not while a
  // dialog is up, where Escape is the dialog's own.
  useEffect(() => {
    if (openedTicket === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.querySelector("dialog[open]") === null) {
        go({ ticketId: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openedTicket, route.threadOpen]);

  return (
    <div className="app">
      <header className="app__header app__header--feature">
        <Brand onClick={() => navigate(home())} />
        <h1 className="app__subject">{feature.title}</h1>
        <span className="app__repositories">
          {feature.repositories
            .map((carried) => repositoryNames.get(carried.projectId) ?? "dépôt inconnu")
            .join(", ")}
        </span>
        {feature.repositories.flatMap((carried) =>
          // Once the graph has drained: one address per repository squad sent
          // off, and the place the rest of that story is told.
          carried.pullRequestUrl === null
            ? []
            : [
                <a
                  key={carried.projectId}
                  className="link"
                  href={carried.pullRequestUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  pull request
                  {feature.repositories.length > 1
                    ? ` ${repositoryNames.get(carried.projectId) ?? ""}`
                    : ""}
                </a>,
              ],
        )}
        {/* In the header of the feature's own tab: how much of this piece of
            work runs without me is the one standing decision taken here. */}
        <AutonomySwitch feature={feature} />
        {narrow && (
          <button
            type="button"
            className="chip"
            aria-expanded={waitingOpen}
            onClick={() => setWaitingOpen((open) => !open)}
          >
            attente {waiting.length}
          </button>
        )}
        <Connection connected={state.connected} />
        <ThemeSwitch theme={state.settings.theme} />
        <button type="button" className="link" onClick={() => navigate({ screen: "settings" })}>
          réglages
        </button>
      </header>

      <main
        className={narrow ? "app__work app__work--narrow" : "app__work"}
        style={
          {
            "--obstructed": `${obstructedRight}px`,
            "--obstructed-bottom": `${obstructedBottom}px`,
          } as CSSProperties
        }
      >
        {(!narrow || waitingOpen) && (
          <aside className={narrow ? "rail rail--over" : "rail"}>
            <WaitingPanel
              actions={waiting}
              openedTicketId={openedTicket?.id ?? null}
              onOpen={(action) => {
                open(action);
                setWaitingOpen(false);
              }}
            />
          </aside>
        )}

        <section className="panel panel--graph" aria-labelledby="titre-graphe">
          <div className="graph__header">
            <h2 id="titre-graphe">Graphe</h2>
          </div>
          <FeatureGraphView
            graph={graph}
            repositoryNames={repositoryNames}
            awaitingDeveloper={ticketsAwaitingDeveloper(waiting)}
            selectedId={openedTicket?.id ?? null}
            obstructedRight={obstructedRight}
            obstructedBottom={obstructedBottom}
            onSelect={(ticketId) => go({ ticketId })}
            onDeselect={() => {
              // Only when something is open: a press on the background is the
              // ordinary way of moving the map, and it would otherwise stack an
              // identical address in the history at every drag.
              if (openedTicket !== null) go({ ticketId: null });
            }}
          />
        </section>

        {openedTicket !== null && (
          <aside className="drawer drawer--ticket" style={{ width: `${ticketWidth}px` }}>
            <Grip
              size={ticketWidth}
              onSize={setTicketWidth}
              axis="width-from-right"
              min={320}
              max={() => window.innerWidth / 2}
              label="Largeur du panneau du ticket"
            />
            <section className="panel panel--ticket" aria-labelledby="titre-ticket">
              <h2 id="titre-ticket">Ticket</h2>
              <TicketPanel
                ticket={openedTicket}
                thread={ticketThreadOf(state, openedTicket.id)}
                questions={ticketQuestionsOf(state, openedTicket.id)}
                repository={
                  repositoryNames.size > 1
                    ? (repositoryNames.get(openedTicket.projectId) ?? null)
                    : null
                }
                onClose={() => go({ ticketId: null })}
              />
            </section>
          </aside>
        )}

        <aside
          className={route.threadOpen ? "drawer drawer--thread drawer--open" : "drawer drawer--thread"}
          style={route.threadOpen ? { height: `${threadHeight}px` } : undefined}
        >
          {route.threadOpen && (
            <Grip
              size={threadHeight}
              onSize={setThreadHeight}
              axis="height-from-bottom"
              min={180}
              max={() => window.innerHeight * 0.7}
              label="Hauteur du fil de la session principale"
            />
          )}
          <h2 className="drawer__bar">
            <button
              type="button"
              className="drawer__handle"
              aria-expanded={route.threadOpen}
              onClick={() => go({ threadOpen: !route.threadOpen })}
            >
              <span aria-hidden="true">{route.threadOpen ? "▾" : "▴"}</span> Session principale
              {/* Marked, never opened by itself: an agent blocked on a question
                  already raises an alert and already shows in the waiting list,
                  and moving half the screen under someone who is reading a step
                  report would buy nothing and cost them their place. */}
              {waiting.some((action) => action.ticketId === null) && (
                <span className="count count--waiting">en attente</span>
              )}
            </button>
          </h2>
          {route.threadOpen && (
            <section className="panel panel--session" aria-label="Session principale">
              <MainSessionView
                feature={feature}
                thread={threadOf(state, feature.id)}
                questions={featureQuestionsOf(state, feature.id)}
                running={isMainSessionRunning(state, feature.id)}
              />
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}

/** The edge one pulls to give a drawer its size, and what announces it. */
function Grip({
  size,
  onSize,
  axis,
  min,
  max,
  label,
}: {
  size: number;
  onSize: (size: number) => void;
  axis: "width-from-right" | "height-from-bottom";
  min: number;
  max: () => number;
  label: string;
}) {
  const drag = useDragSize({ size, onSize, axis, min, max });
  return (
    <span
      className={axis === "width-from-right" ? "grip grip--width" : "grip grip--height"}
      role="separator"
      aria-orientation={axis === "width-from-right" ? "vertical" : "horizontal"}
      aria-label={label}
      {...drag}
    />
  );
}
