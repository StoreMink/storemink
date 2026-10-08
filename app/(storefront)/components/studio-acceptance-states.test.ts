// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  measureChromeStates,
  onScreen,
  type ChromeStateSpec,
} from "./studio-acceptance-states";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const ON = {
  width: 300,
  height: 400,
  left: 0,
  top: 0,
  right: 300,
  bottom: 400,
};
const OFF = {
  width: 300,
  height: 400,
  left: 1024,
  top: 0,
  right: 1324,
  bottom: 400,
};

/** jsdom lays nothing out, so a panel's rectangle follows a flag we control. */
function rectFrom(element: Element, isOpen: () => boolean) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ ...(isOpen() ? ON : OFF), x: 0, y: 0, toJSON: () => ({}) }),
  });
}

function spec(over: Partial<ChromeStateSpec> = {}): ChromeStateSpec {
  return {
    state: "cart",
    trigger: "#open",
    panel: "#panel",
    close: "#close",
    openMs: 1_000,
    ...over,
  };
}

/** A drawer: the trigger opens it, its close button closes it. */
function drawer(options: { opens?: boolean; closes?: boolean } = {}) {
  const { opens = true, closes = true } = options;
  document.body.innerHTML = `<button id="open">Open</button><div id="panel"><button id="close">Close</button><p>Drawer copy</p></div>`;
  const trigger = document.getElementById("open")!;
  const panel = document.getElementById("panel")!;
  const close = document.getElementById("close")!;
  let open = false;
  rectFrom(trigger, () => true);
  rectFrom(close, () => open);
  rectFrom(panel, () => open);
  trigger.addEventListener("click", () => {
    if (opens) open = true;
  });
  close.addEventListener("click", () => {
    if (closes) open = false;
  });
  return { panel, isOpen: () => open };
}

it("an absent trigger is absent, a hidden one is hidden", async () => {
  document.body.innerHTML = `<button id="open" style="display:none">Open</button>`;
  const audit = vi.fn(async () => ({ ok: true }));
  const results = await measureChromeStates(audit, [
    spec({ state: "menu", trigger: "#nowhere" }),
    spec({ state: "cart" }),
  ]);
  expect(results).toEqual([
    { state: "menu", measured: false, reason: "absent" },
    { state: "cart", measured: false, reason: "hidden" },
  ]);
  expect(audit).not.toHaveBeenCalled();
});

it("opens the panel, audits it while open, then closes it", async () => {
  vi.useFakeTimers();
  const { panel, isOpen } = drawer();
  const seenOpen: boolean[] = [];
  const audit = vi.fn(async (el: Element) => {
    seenOpen.push(el === panel && isOpen());
    return { violations: 1 };
  });
  const pending = measureChromeStates(audit, [spec()]);
  await vi.runAllTimersAsync();
  const results = await pending;
  expect(results).toEqual([
    { state: "cart", measured: true, audit: { violations: 1 } },
  ]);
  expect(seenOpen).toEqual([true]);
  expect(isOpen()).toBe(false);
});

it("a control that opens nothing is reported unopened, after one more press", async () => {
  vi.useFakeTimers();
  drawer({ opens: false });
  const presses = vi.fn();
  document.getElementById("open")!.addEventListener("click", presses);
  const pending = measureChromeStates(vi.fn(), [spec()]);
  await vi.runAllTimersAsync();
  expect(await pending).toEqual([
    { state: "cart", measured: false, reason: "unopened" },
  ]);
  expect(presses).toHaveBeenCalledTimes(2);
});

it("a panel that will not close is measured and marked stuck", async () => {
  vi.useFakeTimers();
  const { isOpen } = drawer({ closes: false });
  const pending = measureChromeStates(async () => "audited", [spec()]);
  await vi.runAllTimersAsync();
  expect(await pending).toEqual([
    { state: "cart", measured: true, reason: "stuck", audit: "audited" },
  ]);
  expect(isOpen()).toBe(true);
});

it("a nested state keeps its parent open until it is done, then both close in order", async () => {
  vi.useFakeTimers();
  document.body.innerHTML = `<button id="account">Account</button><div id="menu"><button id="signin">Sign in</button></div><div id="dialog"><button id="dialog-close">Close</button></div>`;
  const account = document.getElementById("account")!;
  const menu = document.getElementById("menu")!;
  const signin = document.getElementById("signin")!;
  const dialog = document.getElementById("dialog")!;
  const dialogClose = document.getElementById("dialog-close")!;
  let menuOpen = false;
  let dialogOpen = false;
  rectFrom(account, () => true);
  rectFrom(menu, () => menuOpen);
  rectFrom(signin, () => menuOpen);
  rectFrom(dialog, () => dialogOpen);
  rectFrom(dialogClose, () => dialogOpen);
  // The real account button toggles its menu.
  account.addEventListener("click", () => {
    menuOpen = !menuOpen;
  });
  signin.addEventListener("click", () => {
    dialogOpen = true;
  });
  dialogClose.addEventListener("click", () => {
    dialogOpen = false;
  });
  const order: string[] = [];
  const audit = vi.fn(async (el: Element) => {
    order.push(`audit:${el.id}:menu=${menuOpen}:dialog=${dialogOpen}`);
    return el.id;
  });
  const pending = measureChromeStates(audit, [
    spec({
      state: "account",
      trigger: "#account",
      panel: "#menu",
      close: "#account",
    }),
    spec({
      state: "sign_in",
      trigger: "#signin",
      panel: "#dialog",
      close: "#dialog-close",
      within: "account",
    }),
  ]);
  await vi.runAllTimersAsync();
  const results = await pending;
  expect(results.map((r) => [r.state, r.measured, r.reason])).toEqual([
    ["account", true, undefined],
    ["sign_in", true, undefined],
  ]);
  // The dialog was audited while the menu was still open.
  expect(order).toEqual([
    "audit:menu:menu=true:dialog=false",
    "audit:dialog:menu=true:dialog=true",
  ]);
  expect(dialogOpen).toBe(false);
  expect(menuOpen).toBe(false);
});

it("onScreen needs a rendered, visible box inside the viewport", () => {
  document.body.innerHTML = `<div id="a"></div><div id="b" style="visibility:hidden"></div><div id="c"></div>`;
  const a = document.getElementById("a")!;
  const b = document.getElementById("b")!;
  const c = document.getElementById("c")!;
  rectFrom(a, () => true);
  rectFrom(b, () => true);
  rectFrom(c, () => false);
  expect(onScreen(a)).toBe(true);
  expect(onScreen(b)).toBe(false);
  expect(onScreen(c)).toBe(false);
  expect(onScreen(null)).toBe(false);
});
