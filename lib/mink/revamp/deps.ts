import "server-only";

// ---------------------------------------------------------------------------
// The production binding of the revamp runner's ports (ports.ts). The runner
// never imports a step module itself, so its tests run on fakes and each step
// module is built and tested on its own; this file is the one place the real
// clients meet.
//
// ★ THE MODEL CLIENTS ARE CHOSEN INSIDE THE STEPS, from `revampProvider()`
//   (provider.ts), read once per call. Binding a client here would let two
//   steps of one run disagree about whether they are faked.
// ---------------------------------------------------------------------------

import {
  assembleRevampPlan,
  estimateRevampCredits,
  fitRevampPlanToBudget,
  revampCarriedProductPhotoKeys,
  revampProductPhotoKeys,
} from "./assemble";
import { createRevampCard, readRevampCreditBalance } from "./card";
import { runRevampChecks } from "./checks";
import { drawRevampPhotos } from "./photos";
import type { RevampDeps } from "./ports";
import { makeRevampProductPhotos } from "./products";
import { compileRevampSite, finalizeRevampSite } from "./site-compiler";
import { planRevampSite, repairRevampSite } from "./site-planner";
import { readRevampSnapshot } from "./snapshot";

export function defaultRevampDeps(): RevampDeps {
  return {
    snapshot: readRevampSnapshot,
    plan: planRevampSite,
    repair: repairRevampSite,
    compile: compileRevampSite,
    finalize: finalizeRevampSite,
    fitBudget: fitRevampPlanToBudget,
    productPhotoKeys: revampProductPhotoKeys,
    carriedProductPhotoKeys: revampCarriedProductPhotoKeys,
    estimate: estimateRevampCredits,
    balance: readRevampCreditBalance,
    photos: drawRevampPhotos,
    products: makeRevampProductPhotos,
    assemble: assembleRevampPlan,
    checks: runRevampChecks,
    card: createRevampCard,
  };
}
