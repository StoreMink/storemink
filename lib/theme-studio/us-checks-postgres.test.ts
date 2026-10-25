// Opt-in local integration (THEME_STUDIO_CAPACITY_DB_TEST=1): the US-first
// photo check (TS-3D) on the real capacity rows of storemink_local. No
// provider call: the SDK is a stand-in that answers by location.
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";

const h = vi.hoisted(() => ({
  run: vi.fn(),
  sentTo: [] as string[],
  next: null as null | ((location: string) => Promise<unknown>),
}));
vi.mock("@/lib/db/client", () => ({ withService: h.run }));
vi.mock("@/lib/observability/logger", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: class {
      readonly location: string;
      models = {
        generateContent: () => {
          h.sentTo.push(this.location);
          return h.next
            ? h.next(this.location)
            : Promise.reject(new Error("no network in tests"));
        },
      };
      constructor(opts: Record<string, unknown>) {
        this.location = String(opts.location);
      }
    },
  };
});

import { createVertexModelClient } from "./gemini-vertex";
import { providerCapacityKey } from "./provider-capacity";
import { sharedProviderCapacity } from "./provider-capacity-store";

it.skipIf(process.env.THEME_STUDIO_CAPACITY_DB_TEST !== "1")(
  "★★ a US 429 pauses only the US row of the shared capacity, and the check's try at global runs on the global row",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    const pool = new Pool({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      max: 4,
      connectionTimeoutMillis: 5000,
    });
    h.run.mockImplementation(async (work) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role app_service");
        const result = await work(drizzle(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    });
    // A project of its own, so its rows are this test's alone.
    const project = randomUUID();
    const model = "gemini-3.8-flash-preview";
    const usKey = providerCapacityKey(project, "us", model);
    const globalKey = providerCapacityKey(project, "global", model);
    try {
      h.sentTo.length = 0;
      h.next = (location) =>
        location === "us"
          ? Promise.reject(
              Object.assign(new Error("Resource has been exhausted"), {
                status: 429,
              }),
            )
          : Promise.resolve({
              candidates: [
                {
                  finishReason: "STOP",
                  content: { parts: [{ text: '{"problems":[]}' }] },
                },
              ],
            });
      // The worker's reviewer setup (worker.ts imageReviewerFor).
      const client = createVertexModelClient(
        { projectId: project, region: "global" },
        {
          capacityAt: (providerModel, location) =>
            sharedProviderCapacity(project, location, providerModel),
          imageReviewTryTimeoutMs: 120_000,
          random: () => 0.5,
        },
      );
      const result = await client.generate(
        {
          stage: "image_review",
          modelKey: "gemini-3.8-flash",
          providerModel: model,
          system: "system",
          content: [{ type: "text", text: "check" }],
          schema: {},
          effort: "high",
        },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ kind: "ok", value: { problems: [] } });
      expect(h.sentTo).toEqual(["us", "global"]);

      const rows = (
        await pool.query(
          `select scope_key, capacity, epoch, successes,
                  pause_until > clock_timestamp() as paused,
                  round(extract(epoch from (pause_until - clock_timestamp())))::int as paused_for_s
             from theme_studio_provider_capacity
            where scope_key = any($1::text[])`,
          [[usKey, globalKey]],
        )
      ).rows as {
        scope_key: string;
        capacity: number;
        epoch: number;
        paused: boolean;
        paused_for_s: number;
      }[];
      const us = rows.find((row) => row.scope_key === usKey);
      const global = rows.find((row) => row.scope_key === globalKey);
      // ★ The US row: one refusal, so one permit and a pause of 15 s at most.
      expect(us).toMatchObject({ capacity: 1, epoch: 1, paused: true });
      expect(us!.paused_for_s).toBeLessThanOrEqual(15);
      // ★ The global row: never paused; its permit came back as a success.
      expect(global).toMatchObject({ capacity: 3, epoch: 0, paused: false });
      // Both permits were given back.
      expect(
        (
          await pool.query(
            "select count(*)::int as n from theme_studio_provider_leases where scope_key = any($1::text[])",
            [[usKey, globalKey]],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await pool.query(
        "delete from theme_studio_provider_capacity where scope_key = any($1::text[])",
        [[usKey, globalKey]],
      );
      await pool.end();
    }
  },
  20_000,
);
