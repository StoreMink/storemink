import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PublishedDoc } from "@/lib/legal/store";

// ---------------------------------------------------------------------------
// A published policy page: the version line shows India's date, and the
// policy's bulleted lists keep their bullets and spacing.
// ---------------------------------------------------------------------------

const data = vi.hoisted(() => ({ doc: null as PublishedDoc | null }));

vi.mock("@/lib/legal/store", () => ({
  getCurrentDoc: vi.fn(async () => data.doc),
}));
vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("notFound");
  }),
}));

import LegalDocPage from "./page";

function publishedPrivacy(effectiveAt: string): PublishedDoc {
  return {
    id: "doc-privacy-4",
    kind: "privacy",
    version: 4,
    title: "Privacy Policy",
    body: "<p><em>Version 4</em></p><ul><li>Account data.</li><li>Staff data.</li></ul>",
    checksum: "0".repeat(64),
    effectiveAt,
  };
}

async function renderPrivacy(effectiveAt: string): Promise<string> {
  data.doc = publishedPrivacy(effectiveAt);
  return renderToStaticMarkup(
    await LegalDocPage({ params: Promise.resolve({ slug: "privacy" }) }),
  );
}

describe("a published policy page", () => {
  // ★ Cloud Run sets no TZ, so the server formats dates in UTC. Run this file
  // the same way: a date that only looks right on a laptop in India fails here.
  const machineTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = "UTC";
  });
  afterAll(() => {
    if (machineTz === undefined) delete process.env.TZ;
    else process.env.TZ = machineTz;
  });

  it("dates a version published before 05:30 IST by the day it took effect in India", async () => {
    // 27 Oct 2026, 04:00 IST is still 26 Oct in UTC.
    const html = await renderPrivacy("2026-10-26T22:30:00.000Z");
    expect(html).toContain("Version 4 · In effect from 27 October 2026");
    expect(html).not.toContain("26 October 2026");
  });

  it("reads the timestamp the database returns, in any offset", async () => {
    expect(await renderPrivacy("2026-10-26 22:30:00.123456+00")).toContain(
      "In effect from 27 October 2026",
    );
    expect(await renderPrivacy("2026-10-26 23:42:14.199269+05:30")).toContain(
      "In effect from 26 October 2026",
    );
  });

  it("renders the stored body, lists included", async () => {
    const html = await renderPrivacy("2026-10-27T10:00:00.000Z");
    expect(html).toContain(
      "<ul><li>Account data.</li><li>Staff data.</li></ul>",
    );
  });
});

describe("the policy stylesheet", () => {
  // The policies carry long bulleted lists (Privacy v4 has 6 lists and 50
  // items). Tailwind's preflight removes bullets, padding and margins, and
  // .smh zeroes list margins, so the page module must put them back.
  const css = readFileSync(
    join(process.cwd(), "app/platform/legal/legal.module.css"),
    "utf8",
  );
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it("gives policy lists bullets, an indent and space after them", () => {
    const list = rule(".body :global(ul)");
    expect(list).toMatch(/list-style:\s*disc;/);
    expect(list).toMatch(/padding-left:\s*1\.4em;/);
    expect(list).toMatch(/margin:\s*0 0 14px;/);
  });

  it("keeps space between list items", () => {
    expect(rule(".body :global(li)")).toMatch(/margin:\s*0 0 8px;/);
  });
});
