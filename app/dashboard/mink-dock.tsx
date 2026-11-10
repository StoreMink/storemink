"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { usePathname } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { MinkFace } from "@/components/mink/mink-face";
import { minkDockSuggestion } from "@/lib/mink/page-suggestions";
import { useChat } from "./chat-context";

/** The bar opens this long after the pointer arrives, and closes this long
 *  after it leaves (unless focus is inside it). */
export const MINK_DOCK_OPEN_DELAY_MS = 150;
export const MINK_DOCK_CLOSE_DELAY_MS = 300;

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
  const { enabled, isChatOpen, skills, pageSuggestion, askInPanel, openChat } =
    useChat();
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
  const dismissing = useRef(false);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const open =
    !coarse &&
    ((hovered && !hoverDismissed) || (focusWithin && !focusDismissed));
  const suggestion = minkDockSuggestion(skills, pathname, pageSuggestion);

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
    // out), so it can take focus now. Moving focus first keeps the field's
    // blur inside the dock; the guard keeps the root's blur handler from
    // reading it as focus leaving.
    dismissing.current = true;
    tabRef.current?.focus();
    dismissing.current = false;
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
    askInPanel(text);
  };

  if (coarse) {
    return (
      <div className="dash-mink-pop" data-mink-dock="">
        <button
          ref={tabRef}
          type="button"
          className="dash-mink-pop-tab"
          aria-controls="mink-chat-panel"
          onClick={() => {
            clearTimers();
            openChat();
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

  return (
    <div
      ref={rootRef}
      className="dash-mink-pop"
      data-mink-dock=""
      data-open={open ? "true" : "false"}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
      onKeyDown={onKeyDown}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (dismissing.current) return;
        const next = event.relatedTarget as Node | null;
        if (next && rootRef.current?.contains(next)) return;
        setFocusWithin(false);
        setFocusDismissed(false);
      }}
    >
      <button
        ref={tabRef}
        type="button"
        className="dash-mink-pop-tab"
        aria-expanded={open}
        aria-controls="mink-dock-bar"
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
            onClick={() => ask(suggestion.prompt)}
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
        >
          <ArrowUp className="h-4 w-4" strokeWidth={2.4} aria-hidden="true" />
        </button>
      </form>
    </div>
  );
}
