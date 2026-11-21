/**
 * The control that opened the Mink AI chat, so closing the chat can give
 * focus back to it (an "Ask Mink" button on a page, the Home box) instead of
 * always the top-bar face. Module state, not React state: it is read once,
 * on close, and must not re-render anything.
 *
 * It is recorded at the click, before the chat renders: by the time the
 * panel is on screen the pop-out bar that was clicked has unmounted and
 * `document.activeElement` is the body.
 */
let opener: HTMLElement | null = null;

export function rememberMinkOpener() {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  opener =
    active instanceof HTMLElement && active !== document.body ? active : null;
}

/**
 * The remembered opener, once, while it is still on the page and outside the
 * chat surfaces; null when it has gone (the pop-out bar unmounts when the
 * chat opens), so the caller falls back to the face.
 */
export function takeMinkOpener(): HTMLElement | null {
  const element = opener;
  opener = null;
  if (!element || !element.isConnected) return null;
  if (element.closest(".mink-chat-surface")) return null;
  if (element.closest("[hidden], [inert]")) return null;
  return element;
}

/**
 * Drops the remembered opener. Called whenever the chat closes by any route
 * (the face, the builder's button, a link tap on a phone), so a later close
 * never sends focus back to a control from an earlier opening.
 */
export function forgetMinkOpener() {
  opener = null;
}
