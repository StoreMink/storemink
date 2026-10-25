// Opt-in local PostgreSQL regression (TS-3B): a photo still unchecked is
// checked before the final capture (image-recovery.ts checkUncheckedPhotos)
// against the real tables, and the result lands where the design review
// reads it. Every fixture and write rolls back; the photo check answers from
// a stub (no network, no model call, nothing paid).
// Run THEME_STUDIO_RECOVERY_DB_TEST=1 with Vitest.
import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import sharp from "sharp";
import { drizzle } from "drizzle-orm/node-postgres";
import { loadEnvConfig } from "@next/env";
import { createFakeModelClient } from "./fake-provider";
import { runThemeGeneration } from "./pipeline";
import {
  applyGeneratedImages,
  generatableSlots,
} from "./image-generation-core";
import { qaImageIssues } from "./qa-image-issues";
import { ZERO_USAGE } from "./provider";
import type { ThemePackageV2 } from "./contracts";

const { service } = vi.hoisted(() => ({ service: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ withService: service }));
vi.mock("@/lib/observability/logger", () => ({
  logError: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { checkUncheckedPhotos } from "./image-recovery";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// The design review's own read of the photos' checks (visual-qa.ts
// evaluateQa), kept here word for word: checkUncheckedPhotos must record on
// the row this query returns, nearest image run first, per stored bytes.
const DESIGN_REVIEW_HISTORY = `
  WITH RECURSIVE chain(id, parent, run_id, depth) AS (
    SELECT v.id, v.parent_version_id, v.run_id, 0 FROM theme_studio_versions v
     WHERE v.id=$1::uuid AND v.project_id=$2::uuid
    UNION ALL
    SELECT v.id, v.parent_version_id, v.run_id, c.depth+1 FROM theme_studio_versions v
     JOIN chain c ON v.id=c.parent WHERE c.depth<50 AND v.project_id=$2::uuid
  )
  SELECT DISTINCT ON (asset->>'sha256') asset->>'sha256' AS "sha256",
    outcome->>'review' AS "review", outcome->>'note' AS "note",
    outcome->'problems' AS "problems"
    FROM chain c JOIN theme_studio_versions v ON v.id=c.id
    JOIN theme_studio_runs r ON r.id=c.run_id AND r.project_id=$2::uuid AND r.kind='images'
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.outcome_detail->'outcomes', '[]'::jsonb)) outcome
    CROSS JOIN LATERAL jsonb_array_elements(v.package_json->'assets') asset
   WHERE outcome->>'status'='generated' AND asset->>'id'=outcome->>'slotId'
   ORDER BY asset->>'sha256', c.depth`;

it.skipIf(process.env.THEME_STUDIO_RECOVERY_DB_TEST !== "1")(
  "checks a carried-over unchecked photo once, records it where the design review reads it, and refuses inside a writing transaction",
  async () => {
    loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
    const pg = new Client({
      host: "127.0.0.1",
      port: 5544,
      database: "storemink_local",
      user: "postgres",
      password: process.env.DB_ADMIN_PASSWORD,
      connectionTimeoutMillis: 5_000,
    });
    await pg.connect();
    try {
      await pg.query("BEGIN");
      await pg.query("SET LOCAL lock_timeout = '5s'");
      const db = drizzle(pg);
      let serial: Promise<unknown> = Promise.resolve();
      service.mockImplementation((work: (db: unknown) => Promise<unknown>) => {
        const result = serial.then(async () => {
          await pg.query("SET LOCAL ROLE app_service");
          try {
            return await work(db);
          } finally {
            await pg.query("RESET ROLE");
          }
        });
        serial = result.catch(() => {});
        return result;
      });

      // The offline provider's theme, with one photo drawn into it.
      const facts = {
        name: "Photo check",
        brief: "A calm ceramics shop.",
        industries: ["home" as const],
        catalogSizes: ["small" as const],
        requiredFeatures: [],
        referenceCount: 0,
      };
      const outcome = await runThemeGeneration(
        createFakeModelClient(facts),
        {
          facts: {
            name: facts.name,
            themeId: "photo-check",
            industries: ["home"],
            catalogSizes: ["small"],
            requiredFeatures: [],
            baseThemeName: null,
          },
          compile: {
            themeId: "photo-check",
            name: facts.name,
            industries: ["home"],
            catalogSizes: ["small"],
            requiredFeatures: [],
            baseEngine: null,
            versionNumber: 1,
            modelKey: "gemini-3.8-flash",
            modelLabel: "Gemini 3.8 Flash",
            referenceDigests: [],
          },
          providerModel: "fake",
          promptVersion: "theme-studio-v1",
          messages: [{ kind: "brief", body: facts.brief }],
          references: [],
        },
        new AbortController().signal,
      );
      if (outcome.kind !== "version") throw new Error(outcome.kind);
      const slot = generatableSlots(outcome.package, outcome.intent)[0];
      const webp = (r: number) =>
        sharp({
          create: {
            width: slot.target.width,
            height: slot.target.height,
            channels: 3,
            background: { r, g: 120, b: 90 },
          },
        })
          .webp()
          .toBuffer();
      const photo = await webp(200);
      const anchorBytes = await webp(40);
      const applied = applyGeneratedImages(
        outcome.package,
        [
          {
            slotId: slot.slotId,
            sha256: sha(photo),
            width: slot.target.width,
            height: slot.target.height,
          },
        ],
        2,
        "gemini-3-pro-image",
      );
      if (!applied.ok) throw new Error(applied.error);
      const drawn: ThemePackageV2 = applied.value;

      const project = randomUUID();
      const brief = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_projects (id, theme_id, name, status, industries, catalog_sizes, model_key, draft_brief, created_by_email)
         VALUES ($1, $2, 'Photo check', 'generating', '{home}', '{small}', 'gemini-3.8-flash', 'A calm ceramics shop', 'test@example.com')`,
        [project, `photo-check-${project}`],
      );
      await pg.query(
        "INSERT INTO theme_studio_messages (id, project_id, kind, body) VALUES ($1, $2, 'brief', 'A calm ceramics shop')",
        [brief, project],
      );
      const anchor = randomUUID();
      await pg.query(
        `INSERT INTO theme_studio_assets (id, project_id, purpose, media_type, bytes, byte_size, width, height, sha256, original_media_type, original_byte_size)
         VALUES ($1,$2,'anchor','image/webp',$3,$4,$5,$6,$7,'image/webp',$4),
                ($8,$2,'image','image/webp',$9,$10,$5,$6,$11,'image/webp',$10)`,
        [
          anchor,
          project,
          anchorBytes,
          anchorBytes.length,
          slot.target.width,
          slot.target.height,
          sha(anchorBytes),
          randomUUID(),
          photo,
          photo.length,
          sha(photo),
        ],
      );
      // v1 from the design run, v2 from the photo run (its check stayed
      // unavailable, so the photo was kept unchecked), v3 from a revision
      // that carried the photo over.
      const run = async (
        kind: "generate" | "images" | "revise",
        base: { id: string; digest: string } | null,
        detail: Record<string, unknown> = {},
      ) => {
        const id = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_runs (id, project_id, message_id, kind, provider, model_key, provider_model, prompt_version, idempotency_key, base_version_id, base_package_digest, context_message_ids, status, attempt_count, finished_at, outcome_detail, usage, created_at)
           VALUES ($1,$2,$3,$4,'vertex-gemini','gemini-3.8-flash','fake','test',$5,$6,$7,$8,'succeeded',1,now(),$9,$10,'1900-01-01')`,
          [
            id,
            project,
            brief,
            kind,
            `photo_check_${id}`,
            base?.id ?? null,
            base?.digest ?? null,
            kind === "revise" ? [brief] : [],
            JSON.stringify(detail),
            JSON.stringify({ estimatedCostMicroUsd: 2_000, reviews: [] }),
          ],
        );
        return id;
      };
      const version = async (
        runId: string,
        number: number,
        pkg: ThemePackageV2,
        parent: string | null,
      ) => {
        const id = randomUUID();
        await pg.query(
          `INSERT INTO theme_studio_versions (id, project_id, run_id, parent_version_id, version_number, intent_json, intent_digest, package_json, package_digest)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            id,
            project,
            runId,
            parent,
            number,
            JSON.stringify(outcome.intent),
            digest(outcome.intent),
            JSON.stringify(pkg),
            digest(pkg),
          ],
        );
        return { id, digest: digest(pkg) };
      };
      const v1 = await version(
        await run("generate", null),
        1,
        outcome.package,
        null,
      );
      const photoRun = await run("images", v1, {
        kind: "images",
        anchorAssetId: anchor,
        outcomes: [
          {
            slotId: slot.slotId,
            status: "generated",
            attempts: 1,
            review: "unreviewed",
          },
        ],
      });
      const v2 = await version(photoRun, 2, drawn, v1.id);
      const v3 = await version(await run("revise", v2), 3, drawn, v2.id);

      const unchecked = async () =>
        qaImageIssues(
          drawn,
          (await pg.query(DESIGN_REVIEW_HISTORY, [v3.id, project])).rows,
        ).filter((issue) => issue.review === "unreviewed");
      expect(await unchecked()).toEqual([
        expect.objectContaining({ slotId: slot.slotId, sha256: sha(photo) }),
      ]);

      // The photo check answers "no problems" through the real parser.
      const generate = vi.fn(async () => ({
        kind: "ok" as const,
        value: { problems: [], note: "" },
        usage: { ...ZERO_USAGE, inputTokens: 1_000, outputTokens: 10 },
      }));
      const reviewer = {
        client: { provider: "vertex-gemini" as const, generate },
        providerModel: "gemini-3.8-flash",
      };
      // This test's own transaction has written its fixtures; a caller's
      // fresh transaction would not have, which is what the guard asks.
      const callerDb = new Proxy(db, {
        get(target, key, receiver) {
          if (key !== "execute") return Reflect.get(target, key, receiver);
          return async (query: Parameters<typeof db.execute>[0]) => {
            const result = await target.execute(query);
            return "held" in (result.rows[0] ?? {})
              ? { ...result, rows: [{ held: false }] }
              : result;
          };
        },
      }) as typeof db;
      const deps = { reviewerFor: () => reviewer };
      const signal = new AbortController().signal;
      expect(
        await checkUncheckedPhotos(
          callerDb as never,
          { projectId: project, versionId: v3.id, signal },
          deps,
        ),
      ).toBe("passed");
      expect(generate).toHaveBeenCalledTimes(1);
      // The check saw the stored crop and the anchor its photo run used.
      const sent = (
        generate.mock.calls[0] as unknown as [
          { stage: string; content: { type: string; base64?: string }[] },
        ]
      )[0];
      expect(sent.stage).toBe("image_review");
      const images = sent.content
        .filter((block) => block.type === "image")
        .map((block) => block.base64);
      expect(images).toEqual([
        photo.toString("base64"),
        anchorBytes.toString("base64"),
      ]);

      // Recorded on the photo run that drew it, in the CHECK's limits.
      const [amended] = (
        await pg.query(
          "SELECT outcome_detail, usage FROM theme_studio_runs WHERE id=$1",
          [photoRun],
        )
      ).rows;
      expect(amended.outcome_detail.outcomes[0]).toMatchObject({
        slotId: slot.slotId,
        status: "generated",
        review: "passed",
        recheckedAt: expect.any(String),
      });
      expect(amended.outcome_detail.outcomes[0]).not.toHaveProperty("recheck");
      expect(amended.usage.reviews).toEqual([
        expect.objectContaining({ recheck: true, outcome: "passed" }),
      ]);
      expect(amended.usage.estimatedCostMicroUsd).toBeGreaterThan(2_000);
      // The design review now reads the photo as checked, for v3 and v2.
      expect(await unchecked()).toEqual([]);
      expect(
        qaImageIssues(
          drawn,
          (await pg.query(DESIGN_REVIEW_HISTORY, [v2.id, project])).rows,
        ),
      ).toEqual([]);
      // Never paid twice: a later call passes at once.
      expect(
        await checkUncheckedPhotos(
          callerDb as never,
          { projectId: project, versionId: v3.id, signal },
          deps,
        ),
      ).toBe("passed");
      expect(generate).toHaveBeenCalledTimes(1);

      // The guard is real: this transaction has written, so a check from
      // inside it is refused before anything is paid for.
      await pg.query(
        `UPDATE theme_studio_runs SET outcome_detail = jsonb_set(outcome_detail, '{outcomes,0,review}', '"unreviewed"') WHERE id=$1`,
        [photoRun],
      );
      await expect(
        checkUncheckedPhotos(
          db as never,
          { projectId: project, versionId: v3.id, signal },
          deps,
        ),
      ).rejects.toThrow("holds no lock and has written nothing");
      expect(generate).toHaveBeenCalledTimes(1);
      // ...and a fresh transaction that has only read passes it.
      const fresh = new Client({
        host: "127.0.0.1",
        port: 5544,
        database: "storemink_local",
        user: "postgres",
        password: process.env.DB_ADMIN_PASSWORD,
        connectionTimeoutMillis: 5_000,
      });
      await fresh.connect();
      try {
        await fresh.query("BEGIN");
        await fresh.query("SELECT 1 FROM theme_studio_projects LIMIT 1");
        expect(
          (
            await fresh.query(
              "SELECT txid_current_if_assigned() IS NOT NULL AS held",
            )
          ).rows[0].held,
        ).toBe(false);
        await fresh.query("ROLLBACK");
      } finally {
        await fresh.end();
      }

      // ★ TS-3 fixer: given withService itself (as the design review now
      // calls it), the check reads, claims and records in short
      // transactions of its own against the real tables, holding none while
      // the photo is checked, and records where the design review reads it.
      generate.mockClear();
      expect(
        await checkUncheckedPhotos(
          service as never,
          { projectId: project, versionId: v3.id, signal },
          deps,
        ),
      ).toBe("passed");
      expect(generate).toHaveBeenCalledTimes(1);
      expect(await unchecked()).toEqual([]);
      const [again] = (
        await pg.query(
          "SELECT outcome_detail, usage FROM theme_studio_runs WHERE id=$1",
          [photoRun],
        )
      ).rows;
      expect(again.outcome_detail.outcomes[0]).toMatchObject({
        review: "passed",
      });
      expect(again.usage.reviews).toHaveLength(2);
    } finally {
      await pg.query("ROLLBACK");
      await pg.end();
    }
  },
  60_000,
);
