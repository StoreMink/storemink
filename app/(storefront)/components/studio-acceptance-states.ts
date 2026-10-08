import {
  type ChromeState,
  type ChromeStateSkip,
} from "@/lib/theme-studio/chrome-states";

// ---------------------------------------------------------------------------
// Opening the storefront's chrome states for the acceptance probe.
//
// Each state is a trigger (the control a shopper presses), the panel that
// appears, and the control that closes it. The probe presses the trigger,
// waits for the panel to be on screen and settled, hands it to an audit
// callback, then closes it and confirms it went away — so the page the
// capture job screenshots afterwards is the page it measured.
//
// ★ Selectors are STABLE HOOKS, never CSS-module class names: aria labels
//   the components already carry for shoppers, ids, and `data-sm` marks.
// ★ The audit decides nothing. Like the rest of the probe it returns raw
//   results; the server applies thresholds and reads `unopened`/`stuck` as
//   coverage failures.
// ---------------------------------------------------------------------------

export interface ChromeStateSpec {
  state: ChromeState;
  /** The control that opens it. */
  trigger: string;
  /** The panel that appears. */
  panel: string;
  /** The control that closes it; Escape and the backdrop are the fallbacks. */
  close: string | null;
  /** How long the panel may take to appear. */
  openMs: number;
  /** A state that opens from inside another one (the sign-in dialog opens
   * from the account menu), so its parent stays open until it is done. */
  within?: ChromeState;
}

export const CHROME_STATE_SPECS: readonly ChromeStateSpec[] = [
  {
    state: "menu",
    trigger: 'button[aria-label="Open Menu"]',
    panel: '[data-sm="menu-drawer"]',
    close: 'button[aria-label="Close Menu"]',
    openMs: 2_500,
  },
  {
    state: "search",
    trigger: 'button[aria-label="Search"][aria-haspopup="dialog"]',
    panel: '[role="dialog"][aria-label="Search the store"]',
    close: 'button[aria-label="Close search"]',
    openMs: 2_500,
  },
  {
    state: "cart",
    trigger: 'button[aria-label="Open cart"]',
    panel: '[role="dialog"][aria-label="Shopping cart"]',
    close: 'button[aria-label="Close cart"]',
    openMs: 2_500,
  },
  {
    state: "account",
    trigger: "#header-profile-btn",
    panel: "#profile-dropdown",
    close: "#header-profile-btn",
    openMs: 2_500,
  },
  {
    // The modal is loaded on first use (auth-modal-loader.tsx), so it is
    // allowed longer. Its close control is the auth modal's; the demo-store
    // notice closes from its backdrop.
    state: "sign_in",
    trigger: "#profile-dropdown button",
    panel: '[data-sm="account-dialog"]',
    close: '[data-sm="account-dialog"] button[aria-label="Close"]',
    openMs: 6_000,
    within: "account",
  },
];

export interface ChromeStateMeasurement<A> {
  state: ChromeState;
  measured: boolean;
  reason?: ChromeStateSkip;
  audit?: A;
}

/** Transitions on these panels run up to 0.4s; measure after they end. */
const SETTLE_MS = 500;
const CLOSE_MS = 1_500;
const POLL_MS = 100;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** On screen as a shopper would see it: rendered, not hidden, inside the
 * viewport. An off-canvas drawer at translateX(100%) is not. */
export function onScreen(element: Element | null): element is Element {
  if (!element) return false;
  const style = getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    parseFloat(style.opacity) === 0
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

async function waitUntil(
  condition: () => boolean,
  ms: number,
): Promise<boolean> {
  for (let waited = 0; ; waited += POLL_MS) {
    if (condition()) return true;
    if (waited >= ms) return false;
    await sleep(POLL_MS);
  }
}

function press(element: Element) {
  if (element instanceof HTMLElement) element.click();
  else element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function escape() {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
}

async function open(spec: ChromeStateSpec): Promise<Element | ChromeStateSkip> {
  const trigger = document.querySelector(spec.trigger);
  if (!trigger) return "absent";
  if (!onScreen(trigger)) return "hidden";
  press(trigger);
  const appeared = () => onScreen(document.querySelector(spec.panel));
  if (!(await waitUntil(appeared, spec.openMs / 2))) {
    // A control that ignored the first press because its data was still
    // loading (the account button waits for the session) gets one more.
    if (onScreen(document.querySelector(spec.trigger))) press(trigger);
    if (!(await waitUntil(appeared, spec.openMs / 2))) return "unopened";
  }
  await sleep(SETTLE_MS);
  const panel = document.querySelector(spec.panel);
  return onScreen(panel) ? panel : "unopened";
}

/** Close the state and confirm it left the screen. */
async function close(spec: ChromeStateSpec): Promise<boolean> {
  const gone = () => !onScreen(document.querySelector(spec.panel));
  if (gone()) return true;
  const closer = spec.close ? document.querySelector(spec.close) : null;
  if (closer && onScreen(closer)) press(closer);
  else escape();
  if (await waitUntil(gone, CLOSE_MS)) {
    await sleep(SETTLE_MS);
    return true;
  }
  // The fallbacks every overlay here supports: its backdrop, then Escape.
  const panel = document.querySelector(spec.panel);
  if (panel) press(panel);
  escape();
  if (await waitUntil(gone, CLOSE_MS)) {
    await sleep(SETTLE_MS);
    return true;
  }
  return false;
}

/**
 * Open, audit and close each chrome state in order. A state that another
 * opens from (the account menu) stays open until its child is done.
 */
export async function measureChromeStates<A>(
  audit: (panel: Element) => Promise<A>,
  specs: readonly ChromeStateSpec[] = CHROME_STATE_SPECS,
): Promise<ChromeStateMeasurement<A>[]> {
  const results: ChromeStateMeasurement<A>[] = [];
  const byState = new Map<ChromeState, ChromeStateMeasurement<A>>();
  const held: ChromeStateSpec[] = [];
  for (const spec of specs) {
    const opened = await open(spec);
    const result: ChromeStateMeasurement<A> =
      typeof opened === "string"
        ? { state: spec.state, measured: false, reason: opened }
        : { state: spec.state, measured: true, audit: await audit(opened) };
    results.push(result);
    byState.set(spec.state, result);
    if (result.measured && specs.some((s) => s.within === spec.state)) {
      held.unshift(spec);
      continue;
    }
    for (const toClose of [spec, ...held.splice(0)]) {
      const closed = await close(toClose);
      if (!closed) {
        const entry = byState.get(toClose.state);
        if (entry) entry.reason = "stuck";
      }
    }
  }
  return results;
}
