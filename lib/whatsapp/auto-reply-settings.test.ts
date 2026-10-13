// ---------------------------------------------------------------------------
// The menu's buttons: the rules WhatsApp applies (three, 20-character
// labels), that a button has what its action needs, and that a stored menu
// an older revision never wrote reads as no menu.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  autoReplySettingsFromRow,
  defaultAutoReplySettings,
  normalizeMenuButtons,
  validateAutoReplySettings,
  validateMenuButtons,
  normalizeMinkMode,
} from "./auto-reply-settings";

const button = (over: Record<string, unknown> = {}) => ({
  id: "b1",
  title: "Check my order",
  action: "order_status",
  text: "",
  ...over,
});

describe("validateMenuButtons", () => {
  it("accepts up to three buttons and keeps their order", () => {
    const r = validateMenuButtons(
      [
        button(),
        button({ id: "b2", title: "Talk to a person", action: "person" }),
        button({
          id: "b3",
          title: "Opening hours",
          action: "text",
          text: "We're open 10 to 7, Monday to Saturday.",
        }),
      ],
      true,
    );
    expect(r).toEqual({
      ok: true,
      buttons: [
        { id: "b1", title: "Check my order", action: "order_status", text: "" },
        { id: "b2", title: "Talk to a person", action: "person", text: "" },
        {
          id: "b3",
          title: "Opening hours",
          action: "text",
          text: "We're open 10 to 7, Monday to Saturday.",
        },
      ],
    });
  });

  it("★ a fourth button is refused: WhatsApp allows three", () => {
    const r = validateMenuButtons(
      [1, 2, 3, 4].map((n) => button({ id: `b${n}`, title: `Button ${n}` })),
      true,
    );
    expect(r).toEqual({
      ok: false,
      error: "A menu can have at most 3 buttons.",
    });
  });

  it("★ a label over 20 characters is refused, naming it", () => {
    const r = validateMenuButtons(
      [button({ title: "Where is my parcel right now" })],
      true,
    );
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/at most 20 characters/);
  });

  it("a menu that is on needs a button; one that is off may have none", () => {
    expect(validateMenuButtons([], true)).toEqual({
      ok: false,
      error: "Add at least one menu button, or turn the menu off.",
    });
    expect(validateMenuButtons(undefined, true).ok).toBe(false);
    expect(validateMenuButtons([], false)).toEqual({ ok: true, buttons: [] });
    expect(validateMenuButtons(undefined, false)).toEqual({
      ok: true,
      buttons: [],
    });
  });

  it("★ a button that sends a message needs the message; a person button may leave it blank", () => {
    expect(
      validateMenuButtons(
        [button({ action: "text", title: "Hours", text: "  " })],
        true,
      ),
    ).toEqual({
      ok: false,
      error: 'Write the message "Hours" sends, or change what it does.',
    });
    expect(
      validateMenuButtons(
        [button({ action: "person", title: "Help", text: "" })],
        true,
      ).ok,
    ).toBe(true);
  });

  it("an order button carries no text whatever was sent", () => {
    const r = validateMenuButtons(
      [button({ action: "order_status", text: "ignored" })],
      true,
    );
    expect(r.ok && r.buttons[0].text).toBe("");
  });

  it("ids and labels are unique, ids are the generated shape, actions are known", () => {
    expect(
      validateMenuButtons([button(), button({ title: "Other" })], true),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/repeats/) });
    expect(
      validateMenuButtons(
        [button(), button({ id: "b2", title: "check MY order" })],
        true,
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/both called/) });
    expect(validateMenuButtons([button({ id: "Bad Id" })], true).ok).toBe(
      false,
    );
    expect(validateMenuButtons([button({ action: "cancel" })], true)).toEqual({
      ok: false,
      error: "Choose what menu button 1 does.",
    });
    expect(validateMenuButtons("nope", false).ok).toBe(false);
  });

  it("collapses a label's spacing and trims the message", () => {
    const r = validateMenuButtons(
      [
        button({
          title: "  Check   my  order ",
          action: "text",
          text: "Hi \r\n",
        }),
      ],
      true,
    );
    expect(r.ok && r.buttons[0]).toEqual({
      id: "b1",
      title: "Check my order",
      action: "text",
      text: "Hi",
    });
  });
});

describe("the menu inside the settings", () => {
  it("is off with no buttons by default", () => {
    expect(defaultAutoReplySettings("Echoss")).toMatchObject({
      menuEnabled: false,
      menuButtons: [],
    });
  });

  it("validateAutoReplySettings carries the menu through and refuses a bad one", () => {
    const base = defaultAutoReplySettings("Echoss");
    const ok = validateAutoReplySettings({
      ...base,
      menuEnabled: true,
      menuButtons: [button()],
    });
    expect(ok.ok && ok.settings.menuButtons).toEqual([
      { id: "b1", title: "Check my order", action: "order_status", text: "" },
    ]);
    expect(
      validateAutoReplySettings({
        ...base,
        menuEnabled: true,
        menuButtons: [],
      }),
    ).toEqual({
      ok: false,
      error: "Add at least one menu button, or turn the menu off.",
    });
    // A row written before the menu existed carries no menu fields at all.
    const legacy = validateAutoReplySettings({
      welcomeEnabled: false,
      welcomeText: "Hi",
      awayEnabled: false,
      awayText: "Closed",
      hours: base.hours,
      orderStatusEnabled: false,
    });
    expect(legacy.ok && legacy.settings).toMatchObject({
      menuEnabled: false,
      menuButtons: [],
    });
  });

  it("★ Mink is off by default; a posted mode must be one of the three; an older row reads as off", () => {
    const base = defaultAutoReplySettings("Echoss");
    expect(base.minkMode).toBe("off");
    for (const minkMode of ["off", "helps", "drafts"] as const) {
      const r = validateAutoReplySettings({ ...base, minkMode });
      expect(r.ok && r.settings.minkMode).toBe(minkMode);
    }
    expect(validateAutoReplySettings({ ...base, minkMode: "always" })).toEqual({
      ok: false,
      error: "Choose what Mink AI does with messages.",
    });
    const { minkMode: _omitted, ...withoutMode } = base;
    void _omitted;
    const legacy = validateAutoReplySettings(withoutMode);
    expect(legacy.ok && legacy.settings.minkMode).toBe("off");
    expect(normalizeMinkMode("drafts")).toBe("drafts");
    expect(normalizeMinkMode("junk")).toBe("off");
    expect(normalizeMinkMode(undefined)).toBe("off");
    expect(
      autoReplySettingsFromRow(
        {
          welcomeEnabled: false,
          welcomeText: "",
          awayEnabled: false,
          awayText: "",
          businessHours: {},
          orderStatusEnabled: false,
          minkMode: "helps",
        },
        "Echoss",
      ).minkMode,
    ).toBe("helps");
  });

  it("★ a stored row from an older revision, or a stored button that no longer passes, never throws", () => {
    expect(
      autoReplySettingsFromRow(
        {
          welcomeEnabled: true,
          welcomeText: "Hi",
          awayEnabled: false,
          awayText: "",
          businessHours: {},
          orderStatusEnabled: false,
        },
        "Echoss",
      ),
    ).toMatchObject({ menuEnabled: false, menuButtons: [] });
    expect(normalizeMenuButtons(null)).toEqual([]);
    expect(normalizeMenuButtons("x")).toEqual([]);
    // One broken button drops; the good ones stay.
    expect(
      normalizeMenuButtons([
        button(),
        { id: "b2", title: "", action: "text", text: "" },
        button({ id: "b3", title: "Hours", action: "text", text: "10 to 7" }),
      ]),
    ).toEqual([
      { id: "b1", title: "Check my order", action: "order_status", text: "" },
      { id: "b3", title: "Hours", action: "text", text: "10 to 7" },
    ]);
  });
});
