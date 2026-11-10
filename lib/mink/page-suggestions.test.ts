import { describe, expect, it } from "vitest";
import {
  evaluateLaunchChecklist,
  type LaunchFacts,
} from "@/lib/store/launch-checklist-rules";
import { MINK_SKILLS, minkStarterSkills } from "./skills";
import { goLiveTaskQuestion, minkDockSuggestion } from "./page-suggestions";

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
