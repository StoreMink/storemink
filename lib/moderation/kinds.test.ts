import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ARCHIVE_FILE_STATES,
  BLOCK_KINDS,
  BLOCK_REASONS,
  COMPLAINT_CHANNELS,
  COMPLAINT_KINDS,
  COMPLAINT_OUTCOMES,
  FILE_SOURCES,
  MESSAGE_SIDES,
  MODERATION_ACTIONS,
  STORAGE_STATES,
  URGENT_COMPLAINT_KINDS,
  appealRoute,
  complaintKindLabel,
  complaintRef,
  isOneOf,
  isOrderReason,
  isUrgentComplaintKind,
  kindWord,
  parseComplaintRef,
  reasonLabel,
  reasonsForKind,
  withArticle,
  type BlockKind,
} from "./kinds";

// ---------------------------------------------------------------------------
// Every list in kinds.ts mirrors a CHECK of migration 0269, in the CHECK's
// own order, so the code and the schema cannot drift. Read from the file
// itself (comments removed), the way lib/moderation/migration.test.ts does.
// ---------------------------------------------------------------------------

const RAW = readFileSync(
  "drizzle/migrations/sql/20261030_0269_content_takedown.sql",
  "utf8",
);
const SQL = RAW.replace(/--[^\n]*/g, " ");

/** The body of `CONSTRAINT <name> CHECK ( ... )`, balanced parentheses. */
function checkBody(name: string): string {
  const head = new RegExp(`CONSTRAINT\\s+${name}\\s+CHECK\\s*\\(`).exec(SQL);
  if (!head) throw new Error(`no CHECK named ${name}`);
  const open = head.index + head[0].length;
  let depth = 1;
  for (let i = open; i < SQL.length; i += 1) {
    if (SQL[i] === "(") depth += 1;
    if (SQL[i] === ")") depth -= 1;
    if (depth === 0) return SQL.slice(open, i);
  }
  throw new Error(`unbalanced CHECK ${name}`);
}

/** The quoted values of a CHECK, in order. */
function quoted(body: string): string[] {
  return [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe("every list matches its CHECK in migration 0269", () => {
  it("block kinds", () => {
    expect([...BLOCK_KINDS]).toEqual(
      quoted(checkBody("content_blocks_kind_check")),
    );
  });

  it("block reasons", () => {
    expect([...BLOCK_REASONS]).toEqual(
      quoted(checkBody("content_blocks_reason_check")),
    );
  });

  it("storage states", () => {
    expect([...STORAGE_STATES]).toEqual(
      quoted(checkBody("content_blocks_storage_values_check")),
    );
  });

  it("file sources: bucket, external, bundled, and no old-storage source", () => {
    const body = checkBody("content_blocks_storage_kind_check");
    const sources = [...body.matchAll(/file_source\s*=\s*'([^']+)'/g)].map(
      (m) => m[1],
    );
    expect([...FILE_SOURCES]).toEqual(sources);
    // The target check's CASE names the same three, in any order.
    const target = checkBody("content_blocks_target_check");
    const caseSources = [
      ...target.matchAll(/WHEN\s+'([a-z]+)'\s+THEN\s+object_path/g),
    ].map((m) => m[1]);
    expect([...caseSources].sort()).toEqual([...FILE_SOURCES].sort());
    expect(FILE_SOURCES).toHaveLength(3);
    expect((FILE_SOURCES as readonly string[]).includes("legacy")).toBe(false);
  });

  it("archive file states", () => {
    expect([...ARCHIVE_FILE_STATES]).toEqual(
      quoted(checkBody("content_block_archives_files_state_check")),
    );
  });

  it("message sides", () => {
    expect([...MESSAGE_SIDES]).toEqual(
      quoted(checkBody("content_block_messages_side_check")),
    );
  });

  it("complaint kinds, channels and outcomes", () => {
    expect([...COMPLAINT_KINDS]).toEqual(
      quoted(checkBody("grievance_complaints_kind_check")),
    );
    expect([...COMPLAINT_CHANNELS]).toEqual(
      quoted(checkBody("grievance_complaints_channel_check")),
    );
    expect([...COMPLAINT_OUTCOMES]).toEqual(
      quoted(checkBody("grievance_complaints_outcome_check")),
    );
  });

  it("moderation record actions", () => {
    expect([...MODERATION_ACTIONS]).toEqual(
      quoted(checkBody("moderation_events_action_check")),
    );
  });

  it("a store's own request only for a review or a comment", () => {
    const body = checkBody("content_blocks_store_request_check");
    const allowed = quoted(body).filter((v) => v !== "store_request");
    expect(allowed).toEqual(["review", "blog_comment"]);
    for (const kind of BLOCK_KINDS) {
      expect(reasonsForKind(kind).includes("store_request"), kind).toBe(
        allowed.includes(kind),
      );
      // Every other reason is open to every kind.
      expect(reasonsForKind(kind).filter((r) => r !== "store_request")).toEqual(
        BLOCK_REASONS.filter((r) => r !== "store_request"),
      );
    }
  });

  it("the order reasons are the ones a block may be kept from the store on", () => {
    const body = checkBody("content_blocks_tell_check");
    const orders = quoted(body);
    expect(orders).toEqual(["court_order", "government_order"]);
    for (const reason of BLOCK_REASONS) {
      expect(isOrderReason(reason), reason).toBe(orders.includes(reason));
    }
  });
});

describe("kindWord and withArticle", () => {
  it("names every kind as a sentence reads it", () => {
    const words: Record<BlockKind, string> = {
      product: "product",
      page: "page",
      blog_post: "blog post",
      collection: "collection",
      review: "review",
      blog_comment: "comment",
      file: "file",
      store: "store",
    };
    for (const kind of BLOCK_KINDS) expect(kindWord(kind)).toBe(words[kind]);
  });

  it("calls a file an image only when its type is an image", () => {
    expect(kindWord("file", "image/webp")).toBe("image");
    expect(kindWord("file", " IMAGE/PNG ")).toBe("image");
    expect(kindWord("file", "application/pdf")).toBe("file");
    expect(kindWord("file", "video/mp4")).toBe("file");
    expect(kindWord("file", null)).toBe("file");
    expect(kindWord("file", "")).toBe("file");
    // The type only matters for a file.
    expect(kindWord("product", "image/png")).toBe("product");
  });

  it("takes an before a vowel and a before anything else", () => {
    expect(withArticle("image")).toBe("an image");
    expect(withArticle("product")).toBe("a product");
    expect(withArticle("blog post")).toBe("a blog post");
    expect(withArticle("review")).toBe("a review");
    expect(withArticle("Image")).toBe("an Image");
    for (const kind of BLOCK_KINDS) {
      for (const type of [null, "image/jpeg", "application/pdf"]) {
        const phrase = withArticle(kindWord(kind, type));
        expect(phrase).not.toMatch(/^a [aeiou]/i);
        expect(phrase).not.toMatch(/^an [^aeiou]/i);
      }
    }
  });
});

describe("labels", () => {
  it("gives every reason and complaint kind a label with no long dash", () => {
    const labels = [
      ...BLOCK_REASONS.map(reasonLabel),
      ...COMPLAINT_KINDS.map(complaintKindLabel),
    ];
    for (const label of labels) {
      expect(label.trim()).toBe(label);
      expect(label).not.toMatch(/[\u2013\u2014[\]]/);
      expect(label.length).toBeGreaterThan(3);
    }
    expect(reasonLabel("government_order")).toBe("Government or police order");
    expect(complaintKindLabel("grievance")).toBe("Other complaint");
    expect(complaintKindLabel("data_request")).toBe("Personal data request");
  });
});

describe("appealRoute", () => {
  it("sends each block where its store can turn", () => {
    expect(appealRoute({ reasonKind: "court_order", complaintId: "c" })).toBe(
      "order",
    );
    expect(
      appealRoute({ reasonKind: "government_order", complaintId: null }),
    ).toBe("order");
    expect(
      appealRoute({
        reasonKind: "intimate_or_impersonation",
        complaintId: "c",
      }),
    ).toBe("committee");
    expect(appealRoute({ reasonKind: "terms_breach", complaintId: null })).toBe(
      "grievance_officer",
    );
    expect(
      appealRoute({ reasonKind: "listed_content", complaintId: undefined }),
    ).toBe("grievance_officer");
    expect(appealRoute({ reasonKind: "store_request", complaintId: "c" })).toBe(
      "none",
    );
  });
});

describe("complaint references", () => {
  it("writes SM- and at least six digits", () => {
    expect(complaintRef(123)).toBe("SM-000123");
    expect(complaintRef(1)).toBe("SM-000001");
    expect(complaintRef(1234567)).toBe("SM-1234567");
    expect(complaintRef(12.9)).toBe("SM-000012");
    expect(complaintRef(Number.NaN)).toBe("SM-000000");
  });

  it("reads one back, any case, and refuses anything else", () => {
    expect(parseComplaintRef("SM-000123")).toBe(123);
    expect(parseComplaintRef(" sm-000123 ")).toBe(123);
    expect(parseComplaintRef(complaintRef(98765))).toBe(98765);
    expect(parseComplaintRef("SM-123")).toBeNull();
    expect(parseComplaintRef("SM-000000")).toBeNull();
    expect(parseComplaintRef("SM-9999999999")).toBeNull();
    expect(parseComplaintRef("XX-000123")).toBeNull();
    expect(parseComplaintRef("SM-00012a")).toBeNull();
  });
});

describe("urgent complaints and isOneOf", () => {
  it("marks the four kinds operators hear about at once", () => {
    expect([...URGENT_COMPLAINT_KINDS]).toEqual([
      "court_order",
      "government_order",
      "information_order",
      "intimate_or_impersonation",
    ]);
    expect(isUrgentComplaintKind("grievance")).toBe(false);
    expect(isUrgentComplaintKind("information_order")).toBe(true);
  });

  it("narrows only a listed string", () => {
    expect(isOneOf(BLOCK_KINDS, "product")).toBe(true);
    expect(isOneOf(BLOCK_KINDS, "Product")).toBe(false);
    expect(isOneOf(BLOCK_KINDS, 3)).toBe(false);
    expect(isOneOf(BLOCK_KINDS, null)).toBe(false);
  });
});
