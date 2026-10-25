/**
 * Run the customer-facing Mink eval set (evals/mink/whatsapp.json).
 *
 *   npm run mink:whatsapp-eval
 *       Offline. Runs every case through the deterministic gate and, for the
 *       answer cases, the parser over a canned model reply: proves the gate,
 *       the fixtures, the facts renderer and the parser agree with the set.
 *       Costs nothing and GRADES NO MODEL.
 *
 *   npm run mink:whatsapp-eval -- --live --yes
 *       Live. Sends each non-gate case to the model exactly as
 *       lib/whatsapp/mink-answer.ts would (the same system instruction, the
 *       same user turn, the same JSON schema), then grades the answer: the
 *       expected outcome, the words an answer must and must not carry, and a
 *       link the facts never gave. Needs ADC and GCP_PROJECT_ID; the model
 *       and location come from MINK_VERTEX_MODEL / MINK_VERTEX_LOCATION.
 *       Each case gets the live path's retry rule on that model (one more
 *       attempt after a 429, a 5xx or a stall, lib/whatsapp/mink-model.ts)
 *       with the Mink fallback switched off, so the grade is the configured
 *       model's alone (mink-whatsapp-eval-core.ts). The report records each
 *       answer's attempts, the model that answered and why it was asked
 *       again, and the summary splits the retried answers into stalls, busy
 *       retries and fallback answers.
 *
 * Options: --cases=id,id, --out=report.json. Exit code 1 when any case fails.
 *
 * ★ It touches no database. The fixture facts are the sheet; nothing is read
 * from a store, so a run says what the prompt and the model do with a given
 * sheet, never what a store's data looks like.
 */
import { loadEnvConfig } from "@next/env";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: () => {} });

import { getMinkConfig } from "@/lib/mink/config";
import {
  allowedUrlsIn,
  parseMinkWhatsAppAnswer,
  type MinkFacts,
} from "@/lib/whatsapp/mink-facts";
import { minkGate } from "@/lib/whatsapp/mink-gate";
import {
  buildMinkWhatsAppUserTurn,
  callMinkWhatsAppModelWithRetry,
} from "@/lib/whatsapp/mink-model";
import {
  evalModelOptions,
  noRetries,
  retrySplit,
  type EvalRetries,
} from "./mink-whatsapp-eval-core";

interface EvalCase {
  id: string;
  fixture: string;
  message: string;
  expect?: "answer" | "hand_over";
  gate?: string;
  mustMention?: string[];
  mustNotMention?: string[];
}

interface Dataset {
  version: string;
  fixtures: Record<string, MinkFacts>;
  cases: EvalCase[];
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface Result {
  id: string;
  passed: boolean;
  outcome: string;
  reply: string;
  reason: string;
  problems: string[];
  latencyMs: number;
  /** Model attempts the answer took: 0 offline, at the gate or on failure. */
  attempts: number;
  /** The model that answered; null offline, at the gate or on failure. */
  model: string | null;
  /** Why the model was asked again, counted whether or not it then answered. */
  retries: EvalRetries;
}

async function main(): Promise<void> {
  const datasetPath = fileURLToPath(
    new URL("../evals/mink/whatsapp.json", import.meta.url),
  );
  const dataset = JSON.parse(await readFile(datasetPath, "utf8")) as Dataset;
  const only = option("cases")?.split(",").filter(Boolean) ?? null;
  const cases = dataset.cases.filter((c) => !only || only.includes(c.id));
  const live = flag("live");

  if (live && !flag("yes")) {
    console.error(
      "A live run calls Vertex once per case. Pass --yes to confirm.",
    );
    process.exit(2);
  }
  const config = getMinkConfig();
  if (live && !config.projectId) {
    console.error("A live run needs GCP_PROJECT_ID (and ADC).");
    process.exit(2);
  }

  const results: Result[] = [];
  const report = (index: number, r: Result) => {
    console.error(
      `[${index + 1}/${cases.length}] ${r.id}: ${r.passed ? "pass" : "FAIL"} (${r.outcome}${
        r.attempts > 1 ? `, ${r.attempts} attempts` : ""
      }${r.problems.length ? `; ${r.problems.join("; ")}` : ""})`,
    );
  };

  for (const [index, c] of cases.entries()) {
    const facts = dataset.fixtures[c.fixture];
    if (!facts) {
      results.push({
        id: c.id,
        passed: false,
        outcome: "fixture_missing",
        reply: "",
        reason: "",
        problems: [`fixture ${c.fixture} is not in the set`],
        latencyMs: 0,
        attempts: 0,
        model: null,
        retries: noRetries(),
      });
      continue;
    }
    const started = Date.now();
    const problems: string[] = [];
    const gate = minkGate(c.message);

    if (c.gate) {
      // A gate case: refused before any model call, with the named reason.
      if (gate.ok) problems.push("the gate let it through");
      else if (gate.reason !== c.gate) {
        problems.push(`gate reason ${gate.reason}, expected ${c.gate}`);
      }
      results.push({
        id: c.id,
        passed: problems.length === 0,
        outcome: gate.ok ? "passed_gate" : `gate:${gate.reason}`,
        reply: "",
        reason: "",
        problems,
        latencyMs: Date.now() - started,
        attempts: 0,
        model: null,
        retries: noRetries(),
      });
      report(index, results[results.length - 1]);
      continue;
    }

    if (!gate.ok) {
      problems.push(`the gate refused it (${gate.reason}) before the model`);
    }
    const allowed = allowedUrlsIn(facts);
    let parsed: unknown;
    let attempts = 0;
    let model: string | null = null;
    const retries = noRetries();
    if (live && gate.ok) {
      try {
        const out = await callMinkWhatsAppModelWithRetry(
          config,
          {
            facts,
            message: c.message,
            now: new Date(),
            timeZone: "Asia/Kolkata",
          },
          evalModelOptions(retries),
        );
        attempts = out.attempts;
        model = out.model;
        // ★ Never graded as the configured model's answer when it is not.
        if (out.model !== config.model) {
          problems.push(`answered by ${out.model}, not ${config.model}`);
        }
        parsed =
          out.finishReason === "STOP"
            ? out.parsed
            : { finishReason: out.finishReason };
      } catch (err) {
        problems.push(
          `model call failed: ${err instanceof Error ? err.message : err}`,
        );
        parsed = null;
      }
    } else {
      // Offline: a canned reply of the expected shape, so the parser and the
      // grading run end to end. It proves the harness, not the model.
      parsed =
        c.expect === "answer"
          ? {
              outcome: "answer",
              reply: `[offline] ${(c.mustMention ?? []).join(" ")}`,
              reason: "offline fixture",
            }
          : { outcome: "hand_over", reply: "", reason: "offline fixture" };
    }
    const answer = gate.ok ? parseMinkWhatsAppAnswer(parsed, allowed) : null;
    if (gate.ok && !answer) problems.push("the answer was not the shape");
    if (answer && c.expect && answer.outcome !== c.expect) {
      problems.push(`outcome ${answer.outcome}, expected ${c.expect}`);
    }
    if (answer?.outcome === "answer") {
      const lower = answer.reply.toLowerCase();
      for (const must of c.mustMention ?? []) {
        if (!lower.includes(must.toLowerCase()))
          problems.push(`missing "${must}"`);
      }
      for (const never of c.mustNotMention ?? []) {
        if (lower.includes(never.toLowerCase()))
          problems.push(`mentions "${never}"`);
      }
      if (/—/.test(answer.reply)) problems.push("reply carries a long dash");
    }
    results.push({
      id: c.id,
      passed: problems.length === 0,
      outcome: answer?.outcome ?? "unparsed",
      reply: answer?.reply ?? "",
      reason: answer?.reason ?? "",
      problems,
      latencyMs: Date.now() - started,
      attempts,
      model,
      retries,
    });
    report(index, results[results.length - 1]);
  }

  const failed = results.filter((r) => !r.passed);
  const summary = {
    dataset: dataset.version,
    mode: live ? "live" : "offline",
    model: live ? config.model : null,
    cases: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    // Answers that needed another attempt, by why: a stall rate and a busy
    // rate, not failures. Fallback answers stay 0 while the eval keeps the
    // fallback off.
    ...retrySplit(results, config.model),
    // The one request the user turn would carry, for a reviewer: the first case.
    sampleUserTurnChars: cases[0]
      ? buildMinkWhatsAppUserTurn({
          facts: dataset.fixtures[cases[0].fixture],
          message: cases[0].message,
        }).length
      : 0,
  };
  const out = option("out");
  const document = JSON.stringify({ summary, results }, null, 2);
  if (out) await writeFile(out, document);
  else console.log(document);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
