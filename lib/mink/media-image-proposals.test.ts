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
  gcsDeletePaths: vi.fn(async () => []),
}));
// ★ The store's one writer (takedown design 5.7) is the seam: the upload
//   guard behind it reads the database, so it is mocked whole here.
vi.mock("@/lib/storage/store-objects", () => ({
  writeStoreObject: vi.fn(
    async (path: string) => `https://storage.googleapis.com/bucket/${path}`,
  ),
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
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
const allowance = vi.hoisted(() => ({
  giveBack: vi.fn(async () => undefined),
}));
vi.mock("./media-generation", async () => {
  // The pure rules are the real ones; the paid call and the claim are not.
  const actual =
    await vi.importActual<typeof import("./media-generation")>(
      "./media-generation",
    );
  return {
    MINK_CHAT_IMAGE_RETRY: actual.MINK_CHAT_IMAGE_RETRY,
    MinkImageNotSentError: actual.MinkImageNotSentError,
    isUnbilledImageFailure: actual.isUnbilledImageFailure,
    generateMinkMediaImage: vi.fn(async () => ({
      bytes: Buffer.from("img"),
      mimeType: "image/jpeg",
    })),
    reserveMinkImageGeneration: vi.fn(async () => ({
      giveBack: allowance.giveBack,
    })),
  };
});
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

import {
  POST_DRAW_RESERVE_MS,
  createMinkMediaImageProposal,
} from "./media-image-proposals";
import {
  MinkImageNotSentError,
  generateMinkMediaImage,
  reserveMinkImageGeneration,
} from "./media-generation";
import {
  MinkImageRateLimitedError,
  MinkRequestError,
  MinkToolInputError,
  MinkToolTimeoutError,
} from "./errors";
import type { MinkToolContext } from "./tools/registry";
import { createMinkDraftProposal } from "./drafts";
import { gcsDeletePaths } from "@/lib/storage/gcs";
import { writeStoreObject } from "@/lib/storage/store-objects";
import { BlockedUploadError } from "@/lib/moderation/upload-guard";
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
    const refused = createMinkMediaImageProposal({
      actor,
      ...ask,
      purpose: "product",
      referenceImageUrls: [
        "https://storage.googleapis.com/bucket/category.webp",
      ],
    });
    await expect(refused).rejects.toThrow(/real photo of the item/);
    // The model reads this back: an attached photo is named by its address,
    // never as a Media URL (an attachment is not in the Media Library).
    await expect(refused).rejects.toThrow(
      "the exact address of a photo the merchant attached",
    );
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

  it("★★ A PRODUCT PHOTO WHOSE ONLY REAL REFERENCE IS A PICTURE ATTACHED IN THIS CHAT GOES AHEAD", async () => {
    // The attachment is read privately (source `attachment`, inline bytes);
    // the draft keeps its address exactly as given, since the card never
    // renders references and the address is readable only by its owner.
    const address =
      "/api/mink/attachments/0f3a9c42-7b1d-4e6a-9c2b-1d5e8f7a6b3c";
    const attached = {
      url: address,
      inlineData: { mimeType: "image/png" as const, data: "AAAA" },
      mimeType: "image/png" as const,
      source: "attachment" as const,
    };
    vi.mocked(resolveMinkMediaReferenceImages).mockResolvedValueOnce([
      attached,
    ]);

    const proposal = await createMinkMediaImageProposal({
      actor,
      ...ask,
      purpose: "product",
      referenceImageUrls: [address],
    });

    expect(proposal.purpose).toBe("product");
    expect(proposal.referenceImageCount).toBe(1);
    expect(vi.mocked(resolveMinkMediaReferenceImages)).toHaveBeenCalledWith(
      actor,
      [address],
    );
    expect(vi.mocked(generateMinkMediaImage).mock.calls[0][2]).toEqual([
      attached,
    ]);
    expect(vi.mocked(createMinkDraftProposal).mock.calls[0][0]).toMatchObject({
      kind: "media_image",
      content: { reference_image_urls: JSON.stringify([address]) },
    });
    // No public copy of the attachment was made on the way.
    expect(writeStoreObject).toHaveBeenCalledTimes(1);
    expect(vi.mocked(writeStoreObject).mock.calls[0][0]).toMatch(
      /mink-generated\/product-photos\//,
    );
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
    const uploaded = vi.mocked(writeStoreObject).mock.calls[0][0];
    expect(dbState.deletes).toBe(1);
    expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledWith([uploaded]);
    // ★ The write tidies up after itself, once; nothing deletes it again.
    expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledTimes(1);
  });

  it("does not return an unusable card when the Media row cannot be saved", async () => {
    dbState.failMediaInsert = true;

    await expect(
      createMinkMediaImageProposal({ actor, ...ask }),
    ).rejects.toThrow(/could not be saved to Media/);
    expect(vi.mocked(createMinkDraftProposal)).not.toHaveBeenCalled();
    const uploaded = vi.mocked(writeStoreObject).mock.calls[0][0];
    expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledWith([uploaded]);
    expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledTimes(1);
  });

  it("★ stores the picture through the store's one writer, for this store", async () => {
    await createMinkMediaImageProposal({ actor, ...ask });
    expect(vi.mocked(writeStoreObject)).toHaveBeenCalledTimes(1);
    const [path, bytes, contentType, options] =
      vi.mocked(writeStoreObject).mock.calls[0];
    expect(path).toMatch(new RegExp(`^stores/${STORE}/mink-generated/`));
    expect(Buffer.from(bytes).toString()).toBe("img");
    expect(contentType).toBe("image/jpeg");
    expect(options).toEqual({
      storeId: STORE,
      via: "mink_media_image",
      actor: "admin-1",
    });
  });

  it("★★ a picture StoreMink has blocked is refused in the design's words, and nothing is saved or charged", async () => {
    vi.mocked(writeStoreObject).mockRejectedValueOnce(
      new BlockedUploadError({
        told: true,
        kindWord: "image",
        blockId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    const refused = createMinkMediaImageProposal({ actor, ...ask });
    await expect(refused).rejects.toBeInstanceOf(MinkRequestError);
    await expect(refused).rejects.toThrow(
      "StoreMink has blocked this image, so it can't be uploaded again. See Settings, Notices from StoreMink.",
    );
    expect(dbState.inserts).toEqual([]);
    expect(vi.mocked(createMinkDraftProposal)).not.toHaveBeenCalled();
    // Nothing was written, so there is nothing to remove.
    expect(vi.mocked(gcsDeletePaths)).not.toHaveBeenCalled();
    // The picture was drawn (Google may have billed it): the allowance stays spent.
    expect(allowance.giveBack).not.toHaveBeenCalled();
  });

  it("★ a block kept from the store refuses the picture without naming it", async () => {
    vi.mocked(writeStoreObject).mockRejectedValueOnce(
      new BlockedUploadError({
        told: false,
        kindWord: "image",
        blockId: "33333333-3333-4333-8333-333333333333",
      }),
    );
    const refused = createMinkMediaImageProposal({ actor, ...ask });
    await expect(refused).rejects.toThrow(
      "This file can't be uploaded. If you need help, write to support@storemink.com.",
    );
    await expect(refused).rejects.not.toThrow(/StoreMink has blocked/);
    expect(dbState.inserts).toEqual([]);
  });
});

/** A tool context like the registry's, its deadline 100 s away. */
function toolContext(): MinkToolContext & {
  stop: AbortController;
  commit: ReturnType<typeof vi.fn>;
} {
  const stop = new AbortController();
  return {
    stop,
    signal: stop.signal,
    deadlineAt: Date.now() + 100_000,
    commit: vi.fn(async (write: () => Promise<unknown>) => {
      if (stop.signal.aborted) throw new MinkToolTimeoutError();
      return write();
    }),
  } as never;
}

describe("★★ a chat image under the tool's deadline (B6, B10)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    toolEnabled.current = true;
    dbState.inserts = [];
    dbState.deletes = 0;
    dbState.failMediaInsert = false;
  });

  it("asks with the chat's retry rule, the tool's stop, and its deadline less the writes' reserve, at 2K with MINIMAL thinking", async () => {
    const context = toolContext();
    await createMinkMediaImageProposal({ actor, ...ask, context });
    expect(vi.mocked(generateMinkMediaImage).mock.calls[0][3]).toEqual({
      rateLimitRetries: 2,
      attemptTimeoutMs: 45_000,
      rateLimitWaitMs: { min: 5_000, max: 15_000 },
      abortSignal: context.signal,
      deadlineAt: context.deadlineAt - POST_DRAW_RESERVE_MS,
      // ★★ Owner, 25 Oct 2026: a chat image at 2K, MINIMAL thinking.
      imageSize: "2K",
      thinkingLevel: "MINIMAL",
    });
    // ★ The Media row and the charged draft are the tool's last write.
    expect(context.commit).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createMinkDraftProposal)).toHaveBeenCalledTimes(1);
  });

  it("★★ gives the store's allowance back when Google never drew the picture (B3)", async () => {
    for (const unbilled of [
      new MinkImageRateLimitedError("busy"),
      new MinkImageNotSentError("image_provider_unavailable", "busy", 503),
    ]) {
      allowance.giveBack.mockClear();
      vi.mocked(generateMinkMediaImage).mockRejectedValueOnce(unbilled);
      await expect(
        createMinkMediaImageProposal({ actor, ...ask, context: toolContext() }),
      ).rejects.toBe(unbilled);
      expect(allowance.giveBack).toHaveBeenCalledTimes(1);
    }
    expect(vi.mocked(writeStoreObject)).not.toHaveBeenCalled();
    expect(vi.mocked(createMinkDraftProposal)).not.toHaveBeenCalled();
  });

  it("★★ keeps it spent for a failure Google may have billed, and for a picture that came back", async () => {
    for (const billed of [
      new MinkRequestError("image_provider_unavailable", "timed out", 503),
      new MinkToolInputError("The image service refused this description."),
    ]) {
      vi.mocked(generateMinkMediaImage).mockRejectedValueOnce(billed);
      await expect(
        createMinkMediaImageProposal({ actor, ...ask, context: toolContext() }),
      ).rejects.toBe(billed);
    }
    await createMinkMediaImageProposal({
      actor,
      ...ask,
      context: toolContext(),
    });
    expect(allowance.giveBack).not.toHaveBeenCalled();
  });

  it("★★ stores, saves and charges nothing when the time ran out during the draw", async () => {
    const context = toolContext();
    vi.mocked(generateMinkMediaImage).mockImplementationOnce(async () => {
      context.stop.abort(new MinkToolTimeoutError());
      return { bytes: Buffer.from("img"), mimeType: "image/jpeg" };
    });
    await expect(
      createMinkMediaImageProposal({ actor, ...ask, context }),
    ).rejects.toBeInstanceOf(MinkToolTimeoutError);
    expect(vi.mocked(writeStoreObject)).not.toHaveBeenCalled();
    expect(dbState.inserts).toEqual([]);
    expect(vi.mocked(createMinkDraftProposal)).not.toHaveBeenCalled();
    // The draw may have been billed: the allowance stays spent.
    expect(allowance.giveBack).not.toHaveBeenCalled();
  });

  it("★★ a write refused at the deadline removes the picture already stored", async () => {
    const context = toolContext();
    vi.mocked(writeStoreObject).mockImplementationOnce(async (path: string) => {
      context.stop.abort(new MinkToolTimeoutError());
      return `https://storage.googleapis.com/bucket/${path}`;
    });
    await expect(
      createMinkMediaImageProposal({ actor, ...ask, context }),
    ).rejects.toBeInstanceOf(MinkToolTimeoutError);
    const uploaded = vi.mocked(writeStoreObject).mock.calls[0][0];
    expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledWith([uploaded]);
    expect(dbState.inserts).toEqual([]);
    expect(vi.mocked(createMinkDraftProposal)).not.toHaveBeenCalled();
  });

  it("★ outside a tool, saves and charges nothing once its own time is up", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.mocked(generateMinkMediaImage).mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 100_001);
        return { bytes: Buffer.from("img"), mimeType: "image/jpeg" };
      });
      await expect(
        createMinkMediaImageProposal({ actor, ...ask }),
      ).rejects.toBeInstanceOf(MinkToolTimeoutError);
      const uploaded = vi.mocked(writeStoreObject).mock.calls[0][0];
      expect(vi.mocked(gcsDeletePaths)).toHaveBeenCalledWith([uploaded]);
      expect(dbState.inserts).toEqual([]);
      expect(vi.mocked(createMinkDraftProposal)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives itself a deadline when called outside a tool", async () => {
    const before = Date.now();
    await createMinkMediaImageProposal({ actor, ...ask });
    const options = vi.mocked(generateMinkMediaImage).mock.calls[0][3]!;
    expect(options.abortSignal).toBeUndefined();
    expect(options.deadlineAt).toBeGreaterThanOrEqual(
      before + 100_000 - POST_DRAW_RESERVE_MS,
    );
  });
});
