"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { usePathname } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { MinkFace } from "@/components/mink/mink-face";
import { minkDockSuggestion } from "@/lib/mink/page-suggestions";
import { useMinkDock } from "./chat-context";

/** The bar opens this long after the pointer arrives, and closes this long
 *  after it leaves (unless focus is inside it). */
export const MINK_DOCK_OPEN_DELAY_MS = 150;
export const MINK_DOCK_CLOSE_DELAY_MS = 300;
/** A pointer click this soon after the pointer opened the bar was aimed at the
 *  tab the bar now covers, not at the button under it. */
export const MINK_DOCK_CLICK_GUARD_MS = 400;

const COARSE_QUERY = "(pointer: coarse)";

function subscribeCoarse(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(COARSE_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function readCoarse() {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(COARSE_QUERY).matches;
}

/**
 * The Mink AI pop-out bar that hangs under the top-bar Mink face. At rest it
 * is a small "Ask Mink AI" tab in the top bar's own colour; pointing at it or
 * tabbing to it slides it out into a bar with a question field and one
 * suggestion for the page. Asking opens the docked side panel (never the full
 * view) on a new chat.
 *
 * On a touch screen the tab is a plain button that opens the panel. It
 * renders nothing while Mink AI is off (also the platform console, which has
 * no chat provider) and while the chat is open: the panel replaces it. CSS
 * hides it below 768px, in the Website Builder, in analytics edit mode and on
 * pages with a pinned save bar (dashboard.css, mink-dock-css.test.ts).
 */
export function MinkDock() {
  // Its own small context: the main chat context changes with every streamed
  // token, and the bar has no reason to re-render with them.
  const { enabled, isChatOpen, skills, pageSuggestion, startChat, openChat } =
    useMinkDock();
  const pathname = usePathname();
  const coarse = useSyncExternalStore(subscribeCoarse, readCoarse, () => false);

  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  // Escape closes the bar. The pointer cannot open it again until it has
  // left the dock, and focus cannot until it has left the dock: two flags,
  // so one way in never blocks the other.
  const [hoverDismissed, setHoverDismissed] = useState(false);
  const [focusDismissed, setFocusDismissed] = useState(false);
  const [draft, setDraft] = useState("");

  const rootRef = useRef<HTMLDivElement | null>(null);
  const tabRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusFieldNext = useRef(false);
  const pointerInside = useRef(false);
  // A mouse press on the tab focuses it before the click: that focus must not
  // open the bar, or the release lands on the bar and the tab's click is lost.
  const pointerPress = useRef(false);
  const hoverOpenedAt = useRef(0);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const open =
    !coarse &&
    ((hovered && !hoverDismissed) || (focusWithin && !focusDismissed));
  // Read by the hover timer, which fires after the render that set it.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  const suggestion = useMemo(
    () => minkDockSuggestion(skills, pathname, pageSuggestion),
    [skills, pathname, pageSuggestion],
  );

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // The chat can open by a route that never passes through ask() (Enter on
  // the face, a keyboard shortcut) while the pointer rests on an open bar.
  // The bar's DOM then goes with no mouseleave, so reset it here; otherwise
  // it would render already open when the chat closes.
  useEffect(() => {
    if (!isChatOpen) return;
    clearTimers();
    pointerInside.current = false;
    focusFieldNext.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resetting local UI state when the chat (an external owner) takes over
    setHovered(false);
    setFocusWithin(false);
    setHoverDismissed(false);
    setFocusDismissed(false);
  }, [isChatOpen, clearTimers]);

  // An explicit activation of the tab (click, Enter, Space) lands in the
  // field once the bar is out. Focus alone leaves focus on the tab.
  useEffect(() => {
    if (open && focusFieldNext.current) {
      focusFieldNext.current = false;
      inputRef.current?.focus();
    }
  }, [open]);

  const dismiss = useCallback(() => {
    clearTimers();
    focusFieldNext.current = false;
    // The tab is never visibility:hidden (only see-through while the bar is
    // out), so it can take focus now. Focus moves inside the dock, so the
    // root's blur handler (relatedTarget inside) leaves it alone.
    tabRef.current?.focus();
    // The tab keeps focus but no longer opens the bar until focus has left
    // the dock; the pointer, until it has left the dock.
    setHovered(false);
    setHoverDismissed(pointerInside.current);
    setFocusDismissed(true);
  }, [clearTimers]);

  // A bar opened by the pointer has no focus to receive Escape: listen on the
  // document while it is out (WCAG 1.4.13, dismissible).
  // It dismisses the hover only, so a keyboard user can still Tab to the tab.
  const focusOpen = focusWithin && !focusDismissed;
  useEffect(() => {
    if (!open || focusOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      clearTimers();
      setHovered(false);
      setHoverDismissed(pointerInside.current);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, focusOpen, clearTimers]);

  if (!enabled || isChatOpen) return null;

  const ask = (text: string) => {
    clearTimers();
    setDraft("");
    setHovered(false);
    setFocusWithin(false);
    startChat(text);
  };

  if (coarse) {
    return (
      <div className="dash-mink-pop" data-mink-dock="">
        <button
          ref={tabRef}
          type="button"
          className="dash-mink-pop-tab"
          // A tap opens the panel without raising the keyboard: the merchant
          // chose to open Mink, not to type yet.
          onClick={() => {
            clearTimers();
            openChat({ focusComposer: false });
          }}
        >
          <MinkFace size={18} />
          <span>Ask Mink AI</span>
          <span className="dash-mink-pop-hit" aria-hidden="true" />
        </button>
      </div>
    );
  }

  const onPointerEnter = () => {
    pointerInside.current = true;
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (hoverDismissed || hovered || openTimer.current !== null) return;
    openTimer.current = window.setTimeout(() => {
      openTimer.current = null;
      // Only a hover that actually brings the bar out arms the click guard.
      // A bar already out (opened by the keyboard or a click on the tab) has
      // been seen, so a click on it is meant for it.
      hoverOpenedAt.current = openRef.current ? 0 : Date.now();
      setHovered(true);
    }, MINK_DOCK_OPEN_DELAY_MS);
  };

  const onPointerLeave = () => {
    pointerInside.current = false;
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    setHoverDismissed(false);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setHovered(false);
    }, MINK_DOCK_CLOSE_DELAY_MS);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    ask(draft);
  };

  // ★ The bar opens over the tab. A pointer click that lands on one of its
  // buttons straight after the pointer opened it was meant for the tab, so it
  // only puts the merchant in the field: never sends a question nobody chose.
  const clickMeantForTab = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (event.detail === 0 || !hovered) return false;
    if (Date.now() - hoverOpenedAt.current >= MINK_DOCK_CLICK_GUARD_MS) {
      return false;
    }
    event.preventDefault();
    inputRef.current?.focus();
    return true;
  };

  // Pressing a bar button keeps focus in the field. Safari never focuses a
  // clicked button, so without this the field's blur names no next element,
  // the bar hides under the pointer and the click is lost.
  const keepFieldFocus = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  return (
    <div
      ref={rootRef}
      className="dash-mink-pop"
      data-mink-dock=""
      data-open={open ? "true" : "false"}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onMouseDown={(event) => {
        pointerPress.current = true;
        // A press on the tab is the merchant choosing it: the hover timer must
        // not bring the bar out mid-press, or the release lands on the bar
        // and the tab's click never runs.
        if (
          openTimer.current !== null &&
          tabRef.current?.contains(event.target as Node)
        ) {
          window.clearTimeout(openTimer.current);
          openTimer.current = null;
        }
        window.setTimeout(() => {
          pointerPress.current = false;
        }, 0);
      }}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        // Only keyboard focus on the tab opens the bar; a mouse press on it
        // leaves that to the click.
        if (pointerPress.current && (event.target as Node) === tabRef.current)
          return;
        setFocusWithin(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (next && rootRef.current?.contains(next)) return;
        // A press inside the dock that focused nothing (Safari, a label's
        // padding) is not focus leaving.
        if (!next && pointerInside.current) return;
        setFocusWithin(false);
        setFocusDismissed(false);
      }}
    >
      <button
        ref={tabRef}
        type="button"
        className="dash-mink-pop-tab"
        aria-expanded={open}
        aria-controls={open ? "mink-dock-bar" : undefined}
        // Focusing it opens the bar and leaves focus here (WCAG 3.2.1): the
        // next Tab reaches the field. While the bar is out the tab is only
        // see-through under it, and the bar carries its focus ring.
        onClick={() => {
          setFocusDismissed(false);
          setFocusWithin(true);
          if (open) inputRef.current?.focus();
          else focusFieldNext.current = true;
        }}
      >
        <MinkFace size={18} />
        <span>Ask Mink AI</span>
      </button>

      <form
        id="mink-dock-bar"
        className="dash-mink-pop-bar"
        hidden={!open}
        onSubmit={onSubmit}
      >
        <label className="dash-mink-pop-field">
          <MinkFace size={18} />
          <input
            ref={inputRef}
            type="text"
            autoComplete="off"
            enterKeyHint="send"
            aria-label="Ask Mink AI anything"
            placeholder="Ask Mink AI anything"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        {suggestion ? (
          <button
            type="button"
            className="dash-mink-pop-suggest"
            aria-label={`Ask: ${suggestion.label}`}
            title={suggestion.label}
            onMouseDown={keepFieldFocus}
            onClick={(event) => {
              if (clickMeantForTab(event)) return;
              ask(suggestion.prompt);
            }}
          >
            <span className="dash-mink-pop-suggest-lead" aria-hidden="true">
              Ask:
            </span>
            <span className="dash-mink-pop-suggest-text">
              {suggestion.label}
            </span>
          </button>
        ) : null}
        <button
          type="submit"
          className="dash-mink-pop-send"
          aria-label="Send question"
          onMouseDown={keepFieldFocus}
          onClick={(event) => {
            clickMeantForTab(event);
          }}
        >
          <ArrowUp className="h-4 w-4" strokeWidth={2.4} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
