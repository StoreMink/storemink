import { describe, expect, it } from "vitest";
import {
  MINK_SKILLS,
  matchMinkSkills,
  minkSkillsFor,
  minkSlashQuery,
  minkStarterSkills,
} from "./skills";

describe("Mink skills", () => {
  it("offers only the skills the viewer's permissions allow", () => {
    const viewerOnly = minkSkillsFor(
      (section, action) =>
        action === "view" &&
        ["dashboard", "analytics", "orders"].includes(section),
    );
    expect(viewerOnly.map((skill) => skill.id)).toEqual([
      "whats-new",
      "sales-today",
      "weekly-summary",
      "pending-orders",
    ]);
    expect(minkSkillsFor(() => false)).toEqual([]);
  });

  it("enters slash mode only for a message that is nothing but a slash word", () => {
    expect(minkSlashQuery("/")).toBe("");
    expect(minkSlashQuery("/Low")).toBe("low");
    expect(minkSlashQuery("/low-stock")).toBe("low-stock");
    expect(minkSlashQuery("open /dashboard/orders")).toBeNull();
    expect(minkSlashQuery("/low stock")).toBeNull();
    expect(minkSlashQuery("/low\nstock")).toBeNull();
    expect(minkSlashQuery("")).toBeNull();
  });

  it("matches a prefix of the slash first, then words in the label or description", () => {
    const names = matchMinkSkills(MINK_SKILLS, "s").map((skill) => skill.slash);
    expect(names.slice(0, 5)).toEqual([
      "sales-today",
      "seo",
      "shipping-audit",
      "social-posts",
      "whats-new",
    ]);
    expect(matchMinkSkills(MINK_SKILLS, "stock").map((s) => s.id)).toEqual([
      "low-stock",
    ]);
    expect(matchMinkSkills(MINK_SKILLS, "").length).toBe(MINK_SKILLS.length);
    expect(matchMinkSkills(MINK_SKILLS, "zzz")).toEqual([]);
  });

  it("leads the starter chips with the page the merchant is on", () => {
    expect(
      minkStarterSkills(MINK_SKILLS, "/dashboard/inventory?location=all").map(
        (skill) => skill.id,
      ),
    ).toEqual(["low-stock", "whats-new", "sales-today", "pending-orders"]);
    expect(
      minkStarterSkills(MINK_SKILLS, "/dashboard/products/abc").map(
        (skill) => skill.id,
      ),
    ).toEqual(["product-photo", "product-description", "seo", "low-stock"]);
    expect(
      minkStarterSkills(MINK_SKILLS, null).map((skill) => skill.id),
    ).toEqual(["whats-new", "sales-today", "low-stock", "pending-orders"]);
    expect(minkStarterSkills([], "/dashboard")).toEqual([]);
  });

  it("has unique slashes and no em dash anywhere", () => {
    const slashes = MINK_SKILLS.map((skill) => skill.slash);
    expect(new Set(slashes).size).toBe(slashes.length);
    for (const skill of MINK_SKILLS) {
      for (const value of [skill.label, skill.description, skill.prompt]) {
        expect(value).not.toContain("—");
      }
      expect(skill.slash).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
