import { describe, expect, it } from "vitest";
import { renderEmailSamples } from "./email-samples";

// ---------------------------------------------------------------------------
// The two rules every email shares, checked against every mailer at once.
//
// 1. ONE STANDARD DESIGN. Every message is framed by the shell in
//    lib/email/shell.ts, so a mailer that hand-rolls its own document (or skips
//    the frame) fails here instead of shipping a one-off look.
// 2. NO LONG DASH (the owner's rule). Neither U+2014 nor U+2013 may appear in a
//    subject or body. Ranges read "5 to 7 working days".
//
// The list is lib/email/email-samples.ts: a new mailer belongs there, which
// also puts it in `npm run email:gallery`.
// ---------------------------------------------------------------------------

const LONG_DASH = /[–—]/;

describe("every StoreMink email", () => {
  const samples = renderEmailSamples();

  it("has a non-trivial list to check", () => {
    // Guards against the list being emptied by a refactor, which would turn
    // every assertion below into a pass.
    expect(samples.length).toBeGreaterThan(40);
    const ids = samples.map((sample) => sample.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(samples.map((sample) => [sample.id, sample] as const))(
    "%s wears the standard frame",
    (_id, sample) => {
      expect(sample.html).toContain('class="sm-email-canvas"');
      expect(sample.html.startsWith("<!DOCTYPE html>")).toBe(true);
      expect(sample.subject.trim()).not.toBe("");
    },
  );

  it.each(samples.map((sample) => [sample.id, sample] as const))(
    "%s has no long dash in its subject or body",
    (_id, sample) => {
      const subjectHit = sample.subject.match(LONG_DASH);
      const htmlHit = sample.html.match(LONG_DASH);
      const context = htmlHit
        ? sample.html.slice(
            Math.max(0, (htmlHit.index ?? 0) - 60),
            (htmlHit.index ?? 0) + 60,
          )
        : "";
      expect(subjectHit, `subject: ${sample.subject}`).toBeNull();
      expect(htmlHit, `body near: ${context}`).toBeNull();
    },
  );
});
