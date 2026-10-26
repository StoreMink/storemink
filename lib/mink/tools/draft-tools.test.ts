import { beforeEach, describe, expect, it, vi } from "vitest";
import { MinkRunStoppedError } from "../errors";
import type { MinkActorContext, MinkArtifact } from "../types";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  prepare: vi.fn(),
  discard: vi.fn(),
  order: [] as string[],
}));

vi.mock("../drafts", () => ({ createMinkDraftProposal: h.create }));
vi.mock("../media-preparation", () => ({
  productPhotoDestination: vi.fn(async () => "product_photo"),
  prepareMinkImageForDestination: h.prepare,
  discardPreparedMinkImage: h.discard,
}));

import { MinkToolRegistry } from "./registry";
import { minkDraftTools } from "./draft-tools";

// ---------------------------------------------------------------------------
// ★★ A PROPOSAL CLAIMS THE RUN ONLY ONCE ITS ARGUMENTS HAVE PASSED (the stop
// handshake, lib/mink/run-stop.ts, 26 Oct 2026). Claimed before the tool
// started, a proposal refused over its arguments still marked the run as
// acted: the merchant's Stop was refused although nothing had been made, and
// the corrected retry was drafted and charged.
// ---------------------------------------------------------------------------

const ACTOR = {
  storeId: "store-1",
  adminId: "admin-1",
  email: null,
  roleSlug: "superadmin",
  permissions: {},
  isSuperadmin: true,
  effectivePlan: "pro",
  locationIds: null,
  analyticsTimeZone: "Asia/Kolkata",
  currency: "INR",
  defaultLowStockThreshold: 5,
  requestId: "request-1",
  runId: "run-1",
  draftingEnabled: true,
} as unknown as MinkActorContext;

const PROPOSAL = {
  type: "proposal",
  draftId: "draft-1",
} as unknown as MinkArtifact;
const COVER = "https://storage.googleapis.com/bucket/stores/s/media/cover.webp";

const registry = new MinkToolRegistry(minkDraftTools);

const message = (args: Record<string, unknown>) => ({
  id: "call-1",
  name: "propose_customer_message",
  args,
});
const blog = (args: Record<string, unknown>) => ({
  id: "call-2",
  name: "propose_blog_draft",
  args: {
    title: "Diwali gifting",
    excerpt: "Our Diwali range",
    content: "Handmade candles for every home.",
    cover_image_url: COVER,
    ...args,
  },
});

function claimAct() {
  return vi.fn(async () => {
    h.order.push("claim");
  });
}

beforeEach(() => {
  h.order = [];
  h.create.mockImplementation(async () => {
    h.order.push("draft");
    return PROPOSAL;
  });
  h.prepare.mockImplementation(async (_actor: unknown, url: string) => {
    h.order.push("media copy");
    return { url, createdPath: "stores/s/media/blog_cover-1.webp" };
  });
  h.discard.mockResolvedValue(undefined);
});

describe("★★ a proposal claims the run only once its arguments have passed", () => {
  it("every proposal in this file is a commit tool", () => {
    const proposals = minkDraftTools.filter((tool) =>
      tool.declaration.name.startsWith("propose_"),
    );
    expect(proposals.length).toBe(18);
    for (const tool of proposals)
      expect(
        registry.effectOf(tool.declaration.name),
        tool.declaration.name,
      ).toBe("commit");
  });

  it("★★ refused over its arguments: no claim, no Media copy, no draft, so a later Stop still wins", async () => {
    const claim = claimAct();
    for (const call of [
      message({ body: "" }),
      message({ body: 42 }),
      blog({ excerpt: "" }),
      blog({ content: undefined }),
      blog({ seo_title: "x".repeat(71) }),
    ]) {
      const response = await registry.execute(ACTOR, call, {
        claimAct: claim,
      });
      expect(response.response, call.name).toMatchObject({
        error: { code: "invalid_tool_input" },
      });
    }
    expect(claim).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("★★ claims just before its first write: the draft, or the Media copy that comes before it", async () => {
    const claim = claimAct();
    const drafted = await registry.execute(
      ACTOR,
      message({ body: "Thank you for shopping with us." }),
      { claimAct: claim },
    );
    expect(drafted).toMatchObject({ artifact: PROPOSAL });
    expect(h.order).toEqual(["claim", "draft"]);

    h.order = [];
    const withCover = await registry.execute(ACTOR, blog({}), {
      claimAct: claim,
    });
    expect(withCover).toMatchObject({ artifact: PROPOSAL });
    expect(h.order).toEqual(["claim", "media copy", "draft"]);
    expect(h.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "blog",
        content: expect.objectContaining({
          title: "Diwali gifting",
          excerpt: "Our Diwali range",
          cover_image_url: COVER,
        }),
      }),
    );
  });

  it("★★ a stop that won first: the chat reads run_stopped, and nothing is copied or drafted", async () => {
    const refused = vi.fn(async () => {
      throw new MinkRunStoppedError();
    });
    for (const call of [
      message({ body: "Thank you for shopping with us." }),
      blog({}),
    ]) {
      const response = await registry.execute(ACTOR, call, {
        claimAct: refused,
      });
      expect(response.response, call.name).toMatchObject({
        error: { code: "run_stopped" },
      });
      expect(response.artifact, call.name).toBeUndefined();
    }
    expect(refused).toHaveBeenCalledTimes(2);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
  });

  it("outside a chat run (no claim given) a proposal is written as before", async () => {
    const response = await registry.execute(
      ACTOR,
      message({ body: "Thank you for shopping with us." }),
    );
    expect(response).toMatchObject({ artifact: PROPOSAL });
    expect(h.order).toEqual(["draft"]);
  });
});
