import { beforeEach, describe, expect, it, vi } from "vitest";

const released = vi.hoisted(() => ({ calls: [] as Array<[string, number]> }));

vi.mock("./image-store", () => ({
  releaseRevampPhotos: vi.fn(async (storeId: string, count: number) => {
    released.calls.push([storeId, count]);
  }),
}));

import {
  REVAMP_REVIEW_PENDING_SUFFIX,
  revampPhotoUnit,
  settleStalePhotoHold,
  storedPhotoUnit,
} from "./photo-hold";
import type { RevampStoredImage } from "./contract";
import type { RevampPhotoHold, RevampStepContext } from "./ports";

const STORE = "b0000000-0000-4000-8000-000000000001";

function row(
  role: RevampStoredImage["role"],
  slotId: string,
): RevampStoredImage {
  return {
    role,
    slotId,
    url: `https://storage.googleapis.com/bucket/${role}-${slotId}.webp`,
    path: `stores/${STORE}/${role}-${slotId}.webp`,
    sha256: "a".repeat(64),
    width: 1600,
    height: 1200,
    review: "passed",
  };
}

/** A step context whose job row holds `held`; records what is written. */
function ctxHolding(held: RevampPhotoHold | null) {
  let current = held;
  const writes: Array<RevampPhotoHold | null> = [];
  const ctx = {
    revampId: "c0000000-0000-4000-8000-000000000001",
    actor: { storeId: STORE },
    signal: new AbortController().signal,
    photoHold: {
      held: () => current,
      record: async (hold: RevampPhotoHold | null) => {
        writes.push(hold);
        current = hold;
        return true;
      },
    },
  } as unknown as RevampStepContext;
  return { ctx, writes };
}

beforeEach(() => {
  released.calls.length = 0;
});

describe("storedPhotoUnit", () => {
  it("reads an ordinary row as the unit it was held under", () => {
    expect(storedPhotoUnit(row("slot", "hero-1"))).toBe("slot:hero-1");
    expect(storedPhotoUnit(row("anchor", "anchor"))).toBe("anchor:anchor");
    expect(storedPhotoUnit(row("product", "p1"))).toBe("product:p1");
  });

  it("★ reads a photo parked for its review as its shot's unit", () => {
    expect(
      storedPhotoUnit(row("slot", `hero-1${REVAMP_REVIEW_PENDING_SUFFIX}`)),
    ).toBe(revampPhotoUnit("slot", "hero-1"));
  });

  it("folds the suffix only for a shot, and never into an empty id", () => {
    // Only the photos step parks, and only shots.
    expect(storedPhotoUnit(row("product", "p1~review"))).toBe(
      "product:p1~review",
    );
    expect(storedPhotoUnit(row("slot", REVAMP_REVIEW_PENDING_SUFFIX))).toBe(
      `slot:${REVAMP_REVIEW_PENDING_SUFFIX}`,
    );
    // A phone crop is its own row, not its shot's.
    expect(storedPhotoUnit(row("slot", "hero-1~phone"))).toBe(
      "slot:hero-1~phone",
    );
  });
});

describe("settleStalePhotoHold", () => {
  it("★★ counts a parked photo as drawn, so only what was never drawn goes back", async () => {
    const { ctx, writes } = ctxHolding({
      units: ["anchor:anchor", "slot:hero-1", "slot:story-1"],
    });
    await settleStalePhotoHold(ctx, [
      row("anchor", "anchor"),
      row("slot", "hero-1~review"),
    ]);
    // ★ Cleared first, then the one photo nobody drew (story-1) goes back.
    expect(writes).toEqual([null]);
    expect(released.calls).toEqual([[STORE, 1]]);
  });

  it("is a no-op when nothing is held", async () => {
    const { ctx, writes } = ctxHolding(null);
    await settleStalePhotoHold(ctx, [row("slot", "hero-1~review")]);
    expect(writes).toEqual([]);
    expect(released.calls).toEqual([]);
  });
});
