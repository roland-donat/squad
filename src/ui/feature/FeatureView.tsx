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
import { TicketModal } from "../ticket/TicketModal";
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
 * waits in taking everything else, and the feature's own conversation in a
 * foldable bar down the right.
 *
 * The bar lies over the map rather than taking a column from it. That is what
 * ADR 0006 asks for: unfolding it must not resize the viewport, or the framing
 * the reader has just made would be undone by the very click that needed it.
 * What it covers is handed to the map instead, which translates a node back out
 * from underneath without touching the scale.
 *
 * A ticket is not on this screen at all. Opening one opens a modal over the
 * whole of it, because treating a ticket is not a glance taken while reading
 * the map, and Escape gives the map back (ADR 0010).
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

  /**
   * What squad opened by itself, per feature and per tab, and may therefore
   * close by itself.
   *
   * The drawer follows the graph while nobody has placed it: a feature whose
   * graph is empty is a feature whose whole business is its thread, since that
   * is where the spec is pasted and the breakdown asked for, and once the
   * breakdown exists that reason is gone. Same rule as the map's framing in ADR
   * 0006, and for the same reason: squad may move what nobody has placed, never
   * what someone has.
   *
   * Which is why the closing is allowed only on a drawer squad opened. An
   * address that asked for the thread, an alert about a question of the main
   * session among them, is never folded away under the person who followed it.
   */
  const auto = useRef<{ feature: string | null; opened: boolean }>({
    feature: null,
    opened: false,
  });

  const go = (selection: { ticketId?: string | null; threadOpen?: boolean }) => {
    // Placing the drawer is what takes it out of squad's hands.
    if (selection.threadOpen !== undefined) auto.current.opened = false;
    navigate(
      featureRoute(feature.id, {
        ticketId: selection.ticketId === undefined ? route.ticketId : selection.ticketId,
        threadOpen: selection.threadOpen === undefined ? route.threadOpen : selection.threadOpen,
      }),
    );
  };

  const written = graph.tickets.length > 0;
  useEffect(() => {
    if (!state.loaded) return;
    const here = featureRoute(feature.id, { ticketId: route.ticketId, threadOpen: !written });
    if (auto.current.feature !== feature.id) {
      auto.current = { feature: feature.id, opened: !written && !route.threadOpen };
      if (auto.current.opened) navigate(here, { replace: true });
      return;
    }
    // The breakdown has arrived under a drawer squad opened on its absence.
    if (written && auto.current.opened && route.threadOpen) {
      auto.current.opened = false;
      navigate(here, { replace: true });
    }
  }, [state.loaded, feature.id, written, route.ticketId, route.threadOpen]);

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

  const [threadWidth, setThreadWidth] = useStoredSize(
    // Kept per feature: how much room a conversation needs is a property of the
    // piece of work being talked about, not of the browser.
    `squad.thread-width.${feature.id}`,
    // A share of the window rather than a number of pixels: the bar holds a
    // conversation and the box one writes into, and a width that suits a large
    // screen leaves no map at all on a laptop.
    Math.max(360, Math.round(window.innerWidth * 0.28)),
  );
  // What the session bar hides of the map, so the map can bring a covered node
  // back into what is left, and the only obstruction there is: the ticket modal
  // covers the map entirely and gives it back on Escape, so there is nothing to
  // translate out from under it. In pixels, because that is what the viewport
  // works in.
  const obstructedRight = route.threadOpen ? threadWidth : 0;

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
          <TicketModal
            ticket={openedTicket}
            feature={feature}
            thread={ticketThreadOf(state, openedTicket.id)}
            questions={ticketQuestionsOf(state, openedTicket.id)}
            repository={
              repositoryNames.size > 1
                ? (repositoryNames.get(openedTicket.projectId) ?? null)
                : null
            }
            onClose={() => go({ ticketId: null })}
            onOpenMainSession={() => go({ ticketId: null, threadOpen: true })}
          />
        )}

        {/* The feature's own conversation, down the right side rather than
            along the bottom: a ticket is now treated in a modal, so this side
            is free, and the two conversations are told apart by where they are
            rather than by a label. Foldable, because a bar that never folds
            would take a third of the map for good on a laptop, which is what
            ADR 0006 refuses (ADR 0010). */}
        <aside
          className={
            route.threadOpen ? "sidebar sidebar--open" : "sidebar"
          }
          style={route.threadOpen ? { width: `${threadWidth}px` } : undefined}
        >
          {route.threadOpen && (
            <Grip
              size={threadWidth}
              onSize={setThreadWidth}
              axis="width-from-right"
              min={300}
              max={() => window.innerWidth / 2}
              label="Largeur du fil de la session principale"
            />
          )}
          <h2 className="sidebar__bar">
            <button
              type="button"
              className="sidebar__handle"
              aria-expanded={route.threadOpen}
              onClick={() => go({ threadOpen: !route.threadOpen })}
            >
              <span aria-hidden="true">{route.threadOpen ? "▸" : "◂"}</span>
              <span className="sidebar__label">Session principale</span>
              {/* Marked, never opened by itself: an agent blocked on a question
                  already raises an alert and already shows in the waiting list,
                  and moving a third of the screen under someone who is reading a
                  step report would buy nothing and cost them their place. */}
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
  /** The only axis there is: the session bar is pulled from its left edge. */
  axis: "width-from-right";
  min: number;
  max: () => number;
  label: string;
}) {
  const drag = useDragSize({ size, onSize, axis, min, max });
  return (
    <span
      className="grip grip--width"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      {...drag}
    />
  );
}
