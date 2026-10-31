// The composer's attachment endpoints: each gate refuses with its own
// sentence, a thrown save is the upload route's sentence, and a discard
// never answers an error.
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ privateBucket: true, allowed: true }));

vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: vi.fn(),
}));
vi.mock("@/lib/mink/attachments", () => ({
  saveMinkAttachment: vi.fn(),
  discardUnsentMinkAttachment: vi.fn(),
  MINK_ATTACHMENT_UPLOAD_FAILED: "Upload failed. Please try again.",
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(async () => ({ allowed: holder.allowed })),
}));
vi.mock("@/lib/storage/gcs", () => ({
  get gcsPrivateConfigured() {
    return holder.privateBucket;
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { getMinkActorContext } from "@/lib/mink/actor-context";
import {
  discardUnsentMinkAttachment,
  saveMinkAttachment,
} from "@/lib/mink/attachments";
import { MinkRequestError } from "@/lib/mink/errors";
import type { MinkActorContext } from "@/lib/mink/types";
import { logError } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import {
  discardMinkAttachment,
  uploadMinkAttachment,
} from "./mink-attachment-actions";

const STORE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SAVED = {
  id: ID,
  url: `/api/mink/attachments/${ID}`,
  filename: "shoe.png",
};

function actorWith(overrides: Partial<MinkActorContext> = {}) {
  return {
    storeId: STORE,
    adminId: "admin-1",
    permissions: { media: ["view", "manage"] },
    isSuperadmin: false,
    ...overrides,
  } as MinkActorContext;
}

function formWith(file: File | null = picture()) {
  const form = new FormData();
  if (file) form.set("file", file);
  // A forged form naming another store and admin: never read.
  form.set("storeId", "ffffffff-ffff-4fff-8fff-ffffffffffff");
  form.set("adminId", "somebody-else");
  return form;
}

function picture() {
  return new File([new Uint8Array([137, 80, 78, 71])], "shoe.png", {
    type: "image/png",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  holder.privateBucket = true;
  holder.allowed = true;
  vi.mocked(getMinkActorContext).mockResolvedValue(actorWith());
  vi.mocked(saveMinkAttachment).mockResolvedValue(SAVED);
  vi.mocked(discardUnsentMinkAttachment).mockResolvedValue(true);
});

describe("uploadMinkAttachment", () => {
  it("★ saves with the actor's store and admin, never the form's, and answers the address", async () => {
    const form = formWith();
    const result = await uploadMinkAttachment(form);
    expect(result).toEqual({
      id: ID,
      url: `/api/mink/attachments/${ID}`,
      filename: "shoe.png",
    });
    expect(saveMinkAttachment).toHaveBeenCalledOnce();
    const input = vi.mocked(saveMinkAttachment).mock.calls[0][0];
    expect(input.storeId).toBe(STORE);
    expect(input.adminId).toBe("admin-1");
    expect(input.file).toBe(form.get("file"));
  });

  it("★ the actor gate refuses in its own words, before any other gate", async () => {
    vi.mocked(getMinkActorContext).mockRejectedValueOnce(
      new MinkRequestError("not_signed_in", "Not signed in.", 401),
    );
    expect(await uploadMinkAttachment(formWith())).toEqual({
      error: "Not signed in.",
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(saveMinkAttachment).not.toHaveBeenCalled();
  });

  it("an actor lookup that fails for another reason is 'Upload failed', logged without content", async () => {
    vi.mocked(getMinkActorContext).mockRejectedValueOnce(
      new Error("connection reset"),
    );
    expect(await uploadMinkAttachment(formWith())).toEqual({
      error: "Upload failed. Please try again.",
    });
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: actor unavailable",
      expect.any(Error),
      { requestId: expect.any(String) },
    );
    expect(saveMinkAttachment).not.toHaveBeenCalled();
  });

  it("★ a role without Media manage can't save images for Mink AI", async () => {
    vi.mocked(getMinkActorContext).mockResolvedValueOnce(
      actorWith({ permissions: { media: ["view"] } }),
    );
    expect(await uploadMinkAttachment(formWith())).toEqual({
      error: "Your role can't save images for Mink AI.",
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(saveMinkAttachment).not.toHaveBeenCalled();
  });

  it("a superadmin passes the role gate without the Media grant", async () => {
    vi.mocked(getMinkActorContext).mockResolvedValueOnce(
      actorWith({ permissions: {}, isSuperadmin: true }),
    );
    expect(await uploadMinkAttachment(formWith())).toEqual(SAVED);
  });

  it("★ without a private bucket, attachments aren't available", async () => {
    holder.privateBucket = false;
    expect(await uploadMinkAttachment(formWith())).toEqual({
      error: "Image attachments aren't available right now.",
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(saveMinkAttachment).not.toHaveBeenCalled();
  });

  it("★ 60 uploads a minute per admin, refused with the upload route's sentence", async () => {
    holder.allowed = false;
    expect(await uploadMinkAttachment(formWith())).toEqual({
      error: "Too many uploads. Please slow down and try again shortly.",
    });
    expect(rateLimit).toHaveBeenCalledWith("mink-attachment:admin-1", {
      max: 60,
      windowSeconds: 60,
    });
    expect(saveMinkAttachment).not.toHaveBeenCalled();
  });

  it("a form with no file stores nothing", async () => {
    expect(await uploadMinkAttachment(formWith(null))).toEqual({
      error: "No file provided.",
    });
    expect(saveMinkAttachment).not.toHaveBeenCalled();
  });

  it("something that is not a form stores nothing", async () => {
    expect(
      await uploadMinkAttachment("not a form" as unknown as FormData),
    ).toEqual({ error: "No file provided." });
    expect(saveMinkAttachment).not.toHaveBeenCalled();
  });

  it("★ a thrown save is 'Upload failed. Please try again.', logged with ids only", async () => {
    vi.mocked(saveMinkAttachment).mockRejectedValueOnce(
      new Error("bucket unreachable"),
    );
    expect(await uploadMinkAttachment(formWith())).toEqual({
      error: "Upload failed. Please try again.",
    });
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: upload threw",
      expect.any(Error),
      { requestId: expect.any(String), storeId: STORE, adminId: "admin-1" },
    );
  });

  it("★ a refusal the save itself answers passes through in its own words", async () => {
    for (const error of [
      "StoreMink has blocked this image, so it can't be uploaded again. See Settings, Notices from StoreMink.",
      "You have too many images waiting to be sent. Send or remove some, then try again.",
      "File too large (6.2 MB). Maximum is 5 MB.",
    ]) {
      vi.mocked(saveMinkAttachment).mockResolvedValueOnce({ error });
      expect(await uploadMinkAttachment(formWith())).toEqual({ error });
    }
    expect(logError).not.toHaveBeenCalled();
  });
});

describe("discardMinkAttachment", () => {
  it("★ discards the caller's own unsent picture and reports it", async () => {
    expect(await discardMinkAttachment(ID.toUpperCase())).toEqual({
      discarded: true,
    });
    expect(discardUnsentMinkAttachment).toHaveBeenCalledWith({
      storeId: STORE,
      adminId: "admin-1",
      id: ID,
    });
  });

  it("nothing of the caller's to discard is false", async () => {
    vi.mocked(discardUnsentMinkAttachment).mockResolvedValueOnce(false);
    expect(await discardMinkAttachment(ID)).toEqual({ discarded: false });
  });

  it("a malformed id discards nothing", async () => {
    for (const id of ["../etc", "", "not-a-uuid", 42 as unknown as string]) {
      expect(await discardMinkAttachment(id)).toEqual({ discarded: false });
    }
    expect(discardUnsentMinkAttachment).not.toHaveBeenCalled();
  });

  it("★ a caller the actor gate refuses gets { discarded: false }, never an error", async () => {
    vi.mocked(getMinkActorContext).mockRejectedValueOnce(
      new MinkRequestError("not_signed_in", "Not signed in.", 401),
    );
    const result = await discardMinkAttachment(ID);
    expect(result).toEqual({ discarded: false });
    expect(result).not.toHaveProperty("error");
    expect(discardUnsentMinkAttachment).not.toHaveBeenCalled();
  });

  it("★ a thrown discard is { discarded: false }, logged with ids only", async () => {
    vi.mocked(discardUnsentMinkAttachment).mockRejectedValueOnce(
      new Error("db down"),
    );
    expect(await discardMinkAttachment(ID)).toEqual({ discarded: false });
    expect(logError).toHaveBeenCalledWith(
      "mink.attachments: discard threw",
      expect.any(Error),
      {
        requestId: expect.any(String),
        storeId: STORE,
        adminId: "admin-1",
        attachmentId: ID,
      },
    );
  });
});
