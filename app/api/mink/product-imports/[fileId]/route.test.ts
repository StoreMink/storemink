import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  queue: vi.fn(),
  preview: vi.fn(),
  read: vi.fn(),
  trigger: vi.fn(),
  emit: vi.fn(),
  after: vi.fn(),
  enabled: true,
}));
vi.mock("next/server", async () => ({
  ...(await vi.importActual("next/server")),
  after: mocks.after,
}));
vi.mock("@/lib/mink/config", () => ({
  getMinkConfig: () => ({ enabled: mocks.enabled }),
}));
vi.mock("@/lib/mink/actor-context", () => ({
  getMinkActorContext: mocks.actor,
}));
vi.mock("@/lib/mink/product-imports", () => ({
  queueMinkProductImport: mocks.queue,
  previewMinkCsv: mocks.preview,
  getMinkCsv: mocks.read,
}));
vi.mock("@/lib/import-export/trigger", () => ({
  triggerImportWorker: mocks.trigger,
}));
vi.mock("@/lib/notifications/record", () => ({ emitEvent: mocks.emit }));
vi.mock("@/lib/observability/logger", () => ({ logError: vi.fn() }));
import { GET, POST } from "./route";
const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ fileId: id }) };
const url = `https://shop.storemink.com/api/mink/product-imports/${id}`;
beforeEach(() => {
  mocks.enabled = true;
  mocks.actor.mockResolvedValue({
    storeId: "store",
    adminId: "owner",
    email: "owner@example.com",
  });
  mocks.queue.mockResolvedValue({ jobId: "job", repeated: false });
  mocks.preview.mockResolvedValue({ artifact: { fileId: id }, job: null });
});
describe("Human product CSV import API", () => {
  it("rejects foreign origins before access or mutations", async () => {
    const result = await POST(
      new Request(url, {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: JSON.stringify({ confirmed: true }),
      }),
      context,
    );
    expect(result.status).toBe(403);
    expect(mocks.actor).not.toHaveBeenCalled();
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("requires approval and refuses client payload replacement", async () => {
    for (const body of [
      { confirmed: false },
      { confirmed: true, csv: "replacement" },
    ]) {
      expect(
        (
          await POST(
            new Request(url, { method: "POST", body: JSON.stringify(body) }),
            context,
          )
        ).status,
      ).toBe(400);
    }
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("queues the exact file and schedules the existing worker", async () => {
    const result = await POST(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ confirmed: true }),
      }),
      context,
    );
    expect(result.status).toBe(200);
    expect(mocks.queue).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: "owner" }),
      id,
    );
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.emit).toHaveBeenCalledOnce();
  });
  it("returns repeated jobs without a duplicate notification", async () => {
    mocks.queue.mockResolvedValue({ jobId: "job", repeated: true });
    expect(
      (
        await POST(
          new Request(url, {
            method: "POST",
            body: JSON.stringify({ confirmed: true }),
          }),
          context,
        )
      ).status,
    ).toBe(200);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
  it("downloads formula-safe CSV privately", async () => {
    mocks.read.mockResolvedValue({
      file: { csv: 'Handle,Title\na,=HYPERLINK("bad")\n' },
    });
    const result = await GET(new Request(url + "?download=1"), context);
    expect(result.headers.get("cache-control")).toContain("private");
    expect(await result.text()).toContain("'=HYPERLINK");
  });
  it("honours runtime shutdown", async () => {
    mocks.enabled = false;
    expect((await GET(new Request(url), context)).status).toBe(404);
    expect(mocks.actor).not.toHaveBeenCalled();
  });
});
