import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";

// ---------------------------------------------------------------------------
// COVERAGE GUARD — every WhatsApp message leaves through the choke point.
//
// Written WITH the channel, as lib/sms/send-coverage.test.ts was, rather than
// after a log had grown holes. A WhatsApp log with a hole in it is worse than
// no log: a merchant searches for the message a customer says never arrived,
// doesn't find it, and concludes it was never sent — when it went by a path
// nobody wired to the log.
// ---------------------------------------------------------------------------

/** The ONLY files allowed to touch the Graph send. */
const TRANSPORT_FILES = [
  // The choke point — the one caller.
  "lib/whatsapp/send.ts",
  // The client, which DEFINES sendTemplateMessage and so matches the grep.
  "lib/whatsapp/graph.ts",
];

function filesCalling(pattern: string): string[] {
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rlE", "--include=*.ts", "--include=*.tsx", pattern, "app", "lib"],
      { encoding: "utf8" },
    );
  } catch {
    return []; // grep exits 1 when nothing matches
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => !f.includes(".test."))
    .filter((f) => !TRANSPORT_FILES.includes(f));
}

describe("whatsapp send coverage", () => {
  it("nothing sends a WhatsApp message outside the choke point", () => {
    // Both Graph sends: the template one the notification spine uses and the
    // free-form one the inbox uses (slice 3).
    const rogue = filesCalling("send(Template|Text|Interactive)Message\\(");
    expect(
      rogue,
      rogue.length
        ? `\n\nThese files call the Graph send directly, so their messages never ` +
            `reach the store's WhatsApp log:\n` +
            rogue.map((f) => `  • ${f}`).join("\n") +
            `\n\nUse sendWhatsAppTemplate() from lib/whatsapp/send.ts instead.\n`
        : "",
    ).toEqual([]);
  });

  // The Graph API is reached by URL as well as by function name, so a new
  // sender could bypass the client entirely and still send.
  it("nothing reaches graph.facebook.com outside the client config", () => {
    const rogue = filesCalling("graph\\.facebook\\.com").filter(
      (f) => f !== "lib/whatsapp/config.ts",
    );
    expect(
      rogue,
      rogue.length
        ? `\n\nThese files reach Meta's Graph API directly, bypassing the ` +
            `client and the log:\n` +
            rogue.map((f) => `  • ${f}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("the choke point writes a log row on every path", () => {
    const source = execFileSync("cat", ["lib/whatsapp/send.ts"], {
      encoding: "utf8",
    });
    for (const status of [
      'status: "sent"',
      'status: "failed"',
      'status: "skipped"',
    ]) {
      expect(
        source.includes(status),
        `lib/whatsapp/send.ts must write a ${status} log row`,
      ).toBe(true);
    }
  });
});
