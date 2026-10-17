import { beforeEach, describe, expect, it, vi } from "vitest";

const toolEnabled = vi.hoisted(() => ({ current: true }));
const dbState = vi.hoisted(() => ({
  inserts: [] as Record<string, unknown>[],
  deletes: 0,
  failMediaInsert: false,
}));

vi.mock("@/lib/db/client", () => {
  const fakeDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ enabled: toolEnabled.current }],
        }),
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (dbState.failMediaInsert) throw new Error("media insert failed");
        dbState.inserts.push(values);
      },
    }),
    delete: () => ({
      where: async () => {
        dbState.deletes += 1;
      },
    }),
  };
  return {
    withService: vi.fn(async (operation: (db: typeof fakeDb) => unknown) =>
      operation(fakeDb),
    ),
  };
});
vi.mock("@/lib/storage/gcs", () => ({
  gcsConfigured: true,
  gcsUploadObject: vi.fn(
    async (path: string) => `https://storage.googleapis.com/bucket/${path}`,
  ),
  gcsDeletePaths: vi.fn(async () => []),
}));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
vi.mock("./config", () => ({ getMinkConfig: () => ({ projectId: "p" }) }));
vi.mock("./drafts", () => ({
  createMinkDraftProposal: vi.fn(async () => ({
    type: "proposal",
    draftId: "11111111-1111-4111-8111-111111111111",
    title: "Hero banner",
    destinationLabel: "Media Library · Hero banner",
    expectedCredits: 3,
    chargedCredits: 3,
    creditSource: "plan",
  })),
}));
vi.mock("./media-generation", () => ({
  generateMinkMediaImage: vi.fn(async () => ({
    bytes: Buffer.from("img"),
    mimeType: "image/jpeg",
  })),
  reserveMinkImageGeneration: vi.fn(async () => undefined),
}));
vi.mock("./media-reference-images", () => ({
  resolveMinkMediaReferenceImages: vi.fn(async () => []),
}));
const chrome = vi.hoisted(() => ({
  cardPhoto: "portrait" as string | undefined,
}));
vi.mock("@/lib/chrome/queries", () => ({
  getStoreChrome: vi.fn(async () => ({
    appearance: { cardPhoto: chrome.cardPhoto },
  })),
}));

import { createMinkMediaImageProposal } from "./media-image-proposals";
import {
  generateMinkMediaImage,
  reserveMinkImageGeneration,
} from "./media-generation";
import { createMinkDraftProposal } from "./drafts";
import { gcsDeletePaths, gcsUploadObject } from "@/lib/storage/gcs";
import { withService } from "@/lib/db/client";
import { resolveMinkMediaReferenceImages } from "./media-reference-images";
import type { MinkActorContext } from "./types";

const STORE = "a0000000-0000-4000-8000-000000000001";

const actor = {
  storeId: STORE,
  adminId: "admin-1",
  runId: "22222222-2222-4222-8222-222222222222",
  draftingEnabled: true,
  isSuperadmin: true,
  permissions: {},
} as unknown as MinkActorContext;

const ask = {
  purpose: "hero",
  prompt: "A warm overhead still life of loose grains on linen.",
  referenceImageUrls: [],
  alt: "Grains and pulses on linen",
};

// ★★ THE ONE FUNCTION THAT JOINS THE TOOL TO THE CONTRACT, and it had no test
// at all — which is why Phase 9E shipped unable to generate a single image.
// The tool used to declare three parameters and the contract demanded a fourth
// (`schemaVersion`) that no caller could send, so every call was refused with
// "The image request is invalid: schemaVersion must be 1." before any provider
// call was made. The contract's own suite passed throughout: its fixture is a
// WIRE payload that always carries the version. A validator and its caller can
// each be correct in isolation and still never agree.
describe("createMinkMediaImageProposal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolEnabled.current = true;
    dbState.inserts = [];
    dbState.deletes = 0;
    dbState.failMediaInsert = false;
  });

  it("★★ ACCEPTS EXACTLY WHAT THE TOOL DECLARES, AND NOTHING MORE", async () => {
    const proposal = await createMinkMediaImageProposal({ actor, ...ask });

    expect(vi.mocked(generateMinkMediaImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateMinkMediaImage).mock.calls[0][1]).toMatchObject({
      purpose: "hero",
      prompt: ask.prompt,
      referenceImageUrls: [],
      alt: ask.alt,
    });
    expect(proposal.type).toBe("media_image_proposal");
    // ★ The aspect comes from the purpose, never from the caller.
    expect(proposal.aspectRatio).toBe("21:9");
    expect(proposal.saved).toBe(true);
    // Authority check, then the immediate Media Library write. The generated
    // URL is usable by a layout proposal in this same model run.
    expect(vi.mocked(withService)).toHaveBeenCalledTimes(2);
    expect(dbState.inserts).toEqual([
      expect.objectContaining({
        storeId: STORE,
        url: proposal.url,
        path: expect.stringMatching(
          new RegExp(`^stores/${STORE}/mink-generated/`),
        ),
        createdBy: actor.adminId,
        // Listed in the Library as a picture Mink made.
        source: "mink_generated",
      }),
    ]);
    expect(proposal.url).toMatch(
      new RegExp(`/stores/${STORE}/mink-generated/[0-9a-f-]+\\.jpg$`),
    );
  });

  it("resolves references before spending and passes only verified images to the provider", async () => {
    const reference = {
      url: "https://storage.googleapis.com/bucket/product.webp",
      fileUri: "gs://bucket/product.webp",
      mimeType: "image/webp" as const,
      source: "product" as const,
    };
    vi.mocked(resolveMinkMediaReferenceImages).mockResolvedValueOnce([
      reference,
    ]);

    const proposal = await createMinkMediaImageProposal({
      actor,
      ...ask,
      referenceImageUrls: [reference.url],
    });

    expect(resolveMinkMediaReferenceImages).toHaveBeenCalledWith(actor, [
      reference.url,
    ]);
    expect(vi.mocked(generateMinkMediaImage).mock.calls[0][2]).toEqual([
      reference,
    ]);
    expect(proposal.referenceImageCount).toBe(1);
  });

  it("★★ REFUSES A PRODUCT PHOTO WITH NO REAL PHOTO OF THE ITEM, BEFORE SPENDING", async () => {
    // A category image is about the category, not the item; nothing, or
    // only that, means Mink would be inventing goods from a description.
    vi.mocked(resolveMinkMediaReferenceImages).mockResolvedValueOnce([
      {
        url: "https://storage.googleapis.com/bucket/category.webp",
        fileUri: "gs://bucket/category.webp",
        mimeType: "image/webp",
        source: "category",
      },
    ]);
    await expect(
      createMinkMediaImageProposal({
        actor,
        ...ask,
        purpose: "product",
        referenceImageUrls: [
          "https://storage.googleapis.com/bucket/category.webp",
        ],
      }),
    ).rejects.toThrow(/real photo of the item/);
    expect(reserveMinkImageGeneration).not.toHaveBeenCalled();
    expect(generateMinkMediaImage).not.toHaveBeenCalled();
    expect(dbState.inserts).toEqual([]);
  });

  it("★ makes a catalogue photo in the store's card shape and keeps it under its own folder", async () => {
    chrome.cardPhoto = "square";
    const reference = {
      url: "https://storage.googleapis.com/bucket/product.webp",
      fileUri: "gs://bucket/product.webp",
      mimeType: "image/webp" as const,
      source: "product" as const,
    };
    vi.mocked(resolveMinkMediaReferenceImages).mockResolvedValueOnce([
      reference,
    ]);

    const proposal = await createMinkMediaImageProposal({
      actor,
      ...ask,
      purpose: "product",
      referenceImageUrls: [reference.url],
    });

    // The shape was read from the store, never from the caller.
    expect(vi.mocked(generateMinkMediaImage).mock.calls[0][1]).toMatchObject({
      purpose: "product",
      productPhotoShape: "square",
    });
    expect(proposal.aspectRatio).toBe("1:1");
    expect(proposal.purpose).toBe("product");
    // The subfolder is what lets propose_product_images accept it while still
    // refusing campaign art.
    expect(proposal.url).toMatch(
      new RegExp(
        `/stores/${STORE}/mink-generated/product-photos/[0-9a-f-]+\\.jpg$`,
      ),
    );
    expect(dbState.inserts[0]).toMatchObject({ source: "mink_generated" });
    // Priced like the photo editor's scene photo: 5 credits, not campaign art's.
    expect(vi.mocked(createMinkDraftProposal).mock.calls[0][0]).toMatchObject({
      kind: "media_image",
      expectedCredits: 5,
    });
    chrome.cardPhoto = "portrait";
  });

  it("★★ AN EARLIER AI PHOTO CAN CONTINUE A SCENE BUT NEVER STANDS IN FOR THE REAL ONE", async () => {
    const earlier = {
      url: `https://storage.googleapis.com/bucket/stores/${STORE}/mink-generated/product-photos/a.jpg`,
      fileUri: `gs://bucket/stores/${STORE}/mink-generated/product-photos/a.jpg`,
      mimeType: "image/jpeg" as const,
      source: "media" as const,
    };
    vi.mocked(resolveMinkMediaReferenceImages).mockResolvedValueOnce([earlier]);
    await expect(
      createMinkMediaImageProposal({
        actor,
        ...ask,
        purpose: "product",
        referenceImageUrls: [earlier.url],
      }),
    ).rejects.toThrow(/real photo of the item/);
    expect(generateMinkMediaImage).not.toHaveBeenCalled();

    // With the real photo beside it, the follow-up goes ahead.
    const real = {
      url: "https://storage.googleapis.com/bucket/product.webp",
      fileUri: "gs://bucket/product.webp",
      mimeType: "image/webp" as const,
      source: "product" as const,
    };
    vi.mocked(resolveMinkMediaReferenceImages).mockResolvedValueOnce([
      real,
      earlier,
    ]);
    const proposal = await createMinkMediaImageProposal({
      actor,
      ...ask,
      purpose: "product",
      referenceImageUrls: [real.url, earlier.url],
    });
    expect(proposal.purpose).toBe("product");
    expect(vi.mocked(generateMinkMediaImage).mock.calls[0][2]).toEqual([
      real,
      earlier,
    ]);
  });

  it("keeps campaign art at the kind's own price", async () => {
    await createMinkMediaImageProposal({ actor, ...ask });
    expect(
      vi.mocked(createMinkDraftProposal).mock.calls[0][0].expectedCredits,
    ).toBeUndefined();
  });

  it("★ CLAIMS THE SPEND CEILING BEFORE THE PROVIDER CALL", async () => {
    // Charging for a picture that was then refused is the one ordering that
    // bills a merchant for nothing.
    await createMinkMediaImageProposal({ actor, ...ask });
    const reserved = vi.mocked(reserveMinkImageGeneration).mock
      .invocationCallOrder[0];
    const generated = vi.mocked(generateMinkMediaImage).mock
      .invocationCallOrder[0];
    expect(reserved).toBeLessThan(generated);
  });

  it("refuses a thin prompt without spending anything", async () => {
    await expect(
      createMinkMediaImageProposal({ ...ask, actor, prompt: "grains" }),
    ).rejects.toThrow(/at least 12 characters/);
    expect(vi.mocked(reserveMinkImageGeneration)).not.toHaveBeenCalled();
    expect(vi.mocked(generateMinkMediaImage)).not.toHaveBeenCalled();
  });

  it("★ REFUSES BEFORE THE PROVIDER WHEN THE STORE'S GATE IS OFF", async () => {
    // The gate gets the only thing worth switching off: the money.
    toolEnabled.current = false;
    await expect(
      createMinkMediaImageProposal({ actor, ...ask }),
    ).rejects.toThrow(/not enabled for this store/);
    expect(vi.mocked(generateMinkMediaImage)).not.toHaveBeenCalled();
  });

  it("★ TIDIES UP THE OBJECT WHEN THE DRAFT CANNOT BE STORED", async () => {
    vi.mocked(createMinkDraftProposal).mockRejectedValueOnce(
      new Error("no credits"),
    );
    await expect(
      createMinkMediaImageProposal({ actor, ...ask }),
    ).rejects.toThrow(/no credits/);
    const uploaded = vi.mocked(gcsUploadObject).mock.calls[0][0];
    expect(dbState.deletes).toBe(1);
    expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledWith([uploaded]);
  });

  it("does not return an unusable card when the Media row cannot be saved", async () => {
    dbState.failMediaInsert = true;

    await expect(
      createMinkMediaImageProposal({ actor, ...ask }),
    ).rejects.toThrow(/could not be saved to Media/);
    expect(vi.mocked(createMinkDraftProposal)).not.toHaveBeenCalled();
    const uploaded = vi.mocked(gcsUploadObject).mock.calls[0][0];
    expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledWith([uploaded]);
  });
});
