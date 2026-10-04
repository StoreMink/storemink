import { expect, it } from "vitest";
import { runThemeBenchmarkBatch } from "./benchmark-batch";
it("queues eight themes at most two at a time, admitting the next as soon as a peer finishes", async () => {
  let time = 0,
    max = 0;
  const active = new Set<string>(),
    queued: string[] = [];
  const result = await runThemeBenchmarkBatch({
    cases: Array.from({ length: 8 }, (_, i) => String(i)),
    concurrency: 2,
    deadlineAt: 100,
    now: () => time,
    createAndQueue: async (id) => {
      queued.push(id);
      active.add(id);
      max = Math.max(max, active.size);
      return id;
    },
    collect: async () => {
      const id = [...active][0];
      active.delete(id);
      return [{ projectId: id, terminal: true }];
    },
    sleep: async () => {
      time++;
    },
  });
  expect(result).toEqual({ queued: 8, timedOut: false });
  expect(max).toBe(2);
  expect(queued).toHaveLength(8);
});
it("saves and reports unfinished IDs without queueing further themes after the deadline", async () => {
  let time = 0;
  const queued: string[] = [];
  const result = await runThemeBenchmarkBatch({
    cases: ["first", "second", "third"],
    concurrency: 2,
    deadlineAt: 5,
    now: () => time,
    createAndQueue: async (id) => {
      queued.push(id);
      return id;
    },
    collect: async () =>
      queued.map((projectId) => ({ projectId, terminal: false })),
    sleep: async () => {
      time += 5;
    },
  });
  expect(result).toEqual({ queued: 2, timedOut: true });
  expect(queued).toEqual(["first", "second"]);
});
