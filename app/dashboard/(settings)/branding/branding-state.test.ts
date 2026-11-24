import { describe, expect, it } from "vitest";
import type { StoreBrand } from "@/lib/store/brand";
import {
  BRAND_DRAFT_KEYS,
  brandDraftForSave,
  brandDraftFrom,
  brandingFormData,
  FALLBACK_PRIMARY,
  normalizeHex,
  readableTextOn,
  sameVoiceDraft,
  validateBrandDraft,
  voiceDraftForSave,
  voiceDraftFrom,
  withScheme,
} from "./branding-state";

const BRAND: StoreBrand = {
  name: "Acme Foods",
  logoUrl: null,
  primaryColor: "#1F7A5A",
  tagline: null,
  blurb: null,
  legalName: null,
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: {
    instagram: "https://instagram.com/acme",
    youtube: null,
    whatsapp: null,
  },
  badges: [],
  domain: "storemink.com",
};

describe("brandDraftFrom", () => {
  it("turns every null into an empty string and lowercases the colour", () => {
    const draft = brandDraftFrom(BRAND);
    expect(draft.primaryColor).toBe("#1f7a5a");
    expect(draft.tagline).toBe("");
    expect(draft.instagram).toBe("https://instagram.com/acme");
    for (const key of BRAND_DRAFT_KEYS) {
      expect(typeof draft[key], key).toBe("string");
    }
  });

  it("falls back to the default colour when the saved one is not a hex", () => {
    expect(brandDraftFrom({ ...BRAND, primaryColor: "red" }).primaryColor).toBe(
      FALLBACK_PRIMARY,
    );
  });
});

describe("brandingFormData", () => {
  it("carries exactly the fields saveStoreBranding reads", () => {
    const form = brandingFormData(brandDraftFrom(BRAND));
    expect([...form.keys()].sort()).toEqual([...BRAND_DRAFT_KEYS].sort());
  });
});

describe("brandDraftForSave", () => {
  it("trims every field and gives a scheme-less social link https://", () => {
    const sent = brandDraftForSave({
      ...brandDraftFrom(BRAND),
      name: "  Acme  ",
      youtube: " youtube.com/@acme ",
      whatsapp: "wa.me/919876543210",
    });
    expect(sent.name).toBe("Acme");
    expect(sent.youtube).toBe("https://youtube.com/@acme");
    expect(sent.whatsapp).toBe("https://wa.me/919876543210");
    expect(sent.instagram).toBe("https://instagram.com/acme");
  });
});

describe("withScheme", () => {
  it("leaves an empty value empty and a value with a scheme as typed", () => {
    expect(withScheme("   ")).toBe("");
    expect(withScheme("http://acme.in")).toBe("http://acme.in");
    expect(withScheme("mailto:hi@acme.in")).toBe("mailto:hi@acme.in");
    expect(withScheme("acme.in")).toBe("https://acme.in");
  });
});

describe("validateBrandDraft", () => {
  it("needs a name and an email that looks like one", () => {
    const draft = brandDraftFrom(BRAND);
    expect(validateBrandDraft(draft)).toEqual({});
    expect(validateBrandDraft({ ...draft, name: " " }).name).toBeTruthy();
    expect(validateBrandDraft({ ...draft, email: "nope" }).email).toBeTruthy();
    expect(validateBrandDraft({ ...draft, email: "a@b.co" })).toEqual({});
  });
});

describe("normalizeHex", () => {
  it("reads 3 and 6 digits, with or without #, in any case", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("abc")).toBe("#aabbcc");
    expect(normalizeHex(" #1A73E8 ")).toBe("#1a73e8");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "#12", "#1234", "#ggg", "red", "#1a73e8ff"]) {
      expect(normalizeHex(bad), bad).toBeNull();
    }
  });
});

describe("readableTextOn", () => {
  it("picks white on dark colours and near-black on light ones", () => {
    expect(readableTextOn("#17130f")).toBe("#ffffff");
    expect(readableTextOn("#1f3fbf")).toBe("#ffffff");
    expect(readableTextOn("#ffd84d")).toBe("#111827");
    expect(readableTextOn("#ffffff")).toBe("#111827");
  });
});

describe("voice drafts", () => {
  it("fill every answer and compare on content and answers", () => {
    const a = voiceDraftFrom({ content: "Guide", structured: { sell: "Tea" } });
    expect(a.answers).toEqual({
      sell: "Tea",
      audience: "",
      personality: "",
      why: "",
      avoid: "",
    });
    expect(
      sameVoiceDraft(
        a,
        voiceDraftFrom({ content: "Guide", structured: { sell: "Tea" } }),
      ),
    ).toBe(true);
    expect(sameVoiceDraft(a, { ...a, content: "Other" })).toBe(false);
  });

  it("trim what is sent", () => {
    const sent = voiceDraftForSave({
      content: "  Guide  ",
      answers: {
        sell: " Tea ",
        audience: "",
        personality: "",
        why: "",
        avoid: "",
      },
    });
    expect(sent.content).toBe("Guide");
    expect(sent.answers.sell).toBe("Tea");
  });
});
