import { describe, expect, it } from "vitest";
import {
  evaluateLaunchChecklist,
  type LaunchFacts,
} from "@/lib/store/launch-checklist-rules";
import { MINK_SKILLS, minkStarterSkills } from "./skills";
import {
  goLiveTaskQuestion,
  minkDockSuggestion,
  minkSuggestedPrompts,
} from "./page-suggestions";

/** A store the minute signup finishes: every required task is open. */
const FRESH: LaunchFacts = {
  plan: "free",
  ownerPhoneVerified: false,
  themeChosen: false,
  publishedProducts: 0,
  sampleProducts: 0,
  business: { name: false, address: false, email: false, phone: false },
  policies: {},
  shippingSaved: false,
  homepageEdited: false,
  logo: false,
  paymentsConnected: false,
  gstin: false,
  customDomainLive: false,
};

describe("minkDockSuggestion", () => {
  it("prefers the page's own suggestion over the skills", () => {
    expect(
      minkDockSuggestion(MINK_SKILLS, "/dashboard", {
        label: "How do I add my first product?",
        prompt: "How do I add my first product?",
      }),
    ).toEqual({
      label: "How do I add my first product?",
      prompt: "How do I add my first product?",
    });
  });

  it("falls back to the first starter skill for the path", () => {
    const [first] = minkStarterSkills(MINK_SKILLS, "/dashboard/orders", 1);
    expect(first).toBeDefined();
    expect(minkDockSuggestion(MINK_SKILLS, "/dashboard/orders", null)).toEqual({
      label: first.label,
      prompt: first.prompt,
    });
  });

  it("ignores an empty page suggestion", () => {
    const [first] = minkStarterSkills(MINK_SKILLS, "/dashboard", 1);
    expect(
      minkDockSuggestion(MINK_SKILLS, "/dashboard", { label: "", prompt: "" }),
    ).toEqual({ label: first.label, prompt: first.prompt });
  });

  it("offers nothing when the viewer has no skills and the page none", () => {
    expect(minkDockSuggestion([], "/dashboard", null)).toBeNull();
  });

  it("ignores a page suggestion with words to show but none to send", () => {
    const [first] = minkStarterSkills(MINK_SKILLS, "/dashboard", 1);
    expect(
      minkDockSuggestion(MINK_SKILLS, "/dashboard", {
        label: "Check my stock",
        prompt: "   ",
      }),
    ).toEqual({ label: first.label, prompt: first.prompt });
  });
});

describe("minkSuggestedPrompts", () => {
  const page = {
    label: "How do I add my first product?",
    prompt: "How do I add my first product?",
  };

  it("leads with the page's question and keeps to the limit", () => {
    const chips = minkSuggestedPrompts(MINK_SKILLS, "/dashboard", page);
    expect(chips).toHaveLength(4);
    expect(chips[0]).toMatchObject({ id: "page-suggestion", ...page });
  });

  it("drops a starter skill that asks the same thing as the page", () => {
    const [first] = minkStarterSkills(MINK_SKILLS, "/dashboard", 1);
    const chips = minkSuggestedPrompts(MINK_SKILLS, "/dashboard", {
      label: "Same question",
      prompt: first.prompt,
    });
    expect(chips.filter((chip) => chip.prompt === first.prompt)).toHaveLength(
      1,
    );
    expect(chips[0].id).toBe("page-suggestion");
  });

  it("is the starter skills alone without a usable page question", () => {
    const starters = minkStarterSkills(MINK_SKILLS, "/dashboard/orders");
    expect(
      minkSuggestedPrompts(MINK_SKILLS, "/dashboard/orders", {
        label: "",
        prompt: "x",
      }).map((chip) => chip.id),
    ).toEqual(starters.map((skill) => skill.id));
  });

  it("agrees with the bar about what leads", () => {
    const [chip] = minkSuggestedPrompts(MINK_SKILLS, "/dashboard", page);
    expect(minkDockSuggestion(MINK_SKILLS, "/dashboard", page)).toEqual({
      label: chip.label,
      prompt: chip.prompt,
    });
  });
});

describe("goLiveTaskQuestion", () => {
  it("has a question for every required go-live task", () => {
    const required = evaluateLaunchChecklist(FRESH).items.filter(
      (item) => item.required,
    );
    expect(required.length).toBeGreaterThan(0);
    for (const item of required) {
      const question = goLiveTaskQuestion(item.key);
      expect(question, item.key).not.toBeNull();
      expect(question?.label).toBe(question?.prompt);
      expect(question?.label).toMatch(/\?$/);
    }
  });

  it("has none for any other key", () => {
    expect(goLiveTaskQuestion("logo")).toBeNull();
    expect(goLiveTaskQuestion("toString")).toBeNull();
    expect(goLiveTaskQuestion("")).toBeNull();
    expect(goLiveTaskQuestion(null)).toBeNull();
  });
});
