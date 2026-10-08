/**
 * The storefront's chrome states: the menus, drawers and dialogs a shopper
 * opens from the header. All of them are hidden when a page loads, so a
 * measurement of the loaded page never sees them — the roastery's 1.37:1
 * delivery trigger (benchmark 2026-10-04, P1 #2) lived in the open phone
 * menu and was found by a human. The acceptance probe opens each one on the
 * home page and audits it; the browser gates expect those results.
 *
 * Dependency-free on purpose: the probe (client) and the gates (server)
 * both import it.
 */
export const CHROME_STATES = [
  "menu",
  "search",
  "cart",
  "account",
  "sign_in",
] as const;

export type ChromeState = (typeof CHROME_STATES)[number];

export const CHROME_STATE_LABELS: Record<ChromeState, string> = {
  menu: "menu drawer",
  search: "search sheet",
  cart: "cart drawer",
  account: "account menu",
  sign_in: "sign-in dialog",
};

/**
 * Why a state was not measured. `absent` and `hidden` are ordinary: a
 * catalogue-only store has no cart button, a desktop header has no hamburger.
 * `unopened` (the control was pressed and nothing appeared) and `stuck` (it
 * opened but would not close) are defects, and the coverage gate says so.
 */
export const CHROME_STATE_SKIPS = [
  "absent",
  "hidden",
  "unopened",
  "stuck",
] as const;

export type ChromeStateSkip = (typeof CHROME_STATE_SKIPS)[number];
