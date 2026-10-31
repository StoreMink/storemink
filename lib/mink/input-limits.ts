import "server-only";
import { sql } from "drizzle-orm";
import { withService } from "@/lib/db/client";
import { MinkRequestError } from "./errors";
import { MINK_INPUT_FILES } from "./input-policy";
import type { MinkActorContext } from "./types";

/**
 * ★★ EVERY BUCKET HERE COUNTS FILES, AND ONE MESSAGE NOW CARRIES UP TO
 * `MINK_INPUT_FILES` OF THEM. These numbers were written when a message meant
 * exactly one provider call, so the owner bucket (5) became EQUAL to the
 * per-message file cap the moment multi-file attachments shipped: a single
 * five-file send spent the whole minute. And `submit()` re-extracts every
 * attachment on a retry — it rebuilds the message from scratch — so the first
 * retry after any mid-batch failure was refused with "the input limit was
 * reached", leaving the merchant unable to send that message, or any other
 * attachment, for up to a minute.
 *
 * ★ SO THE OWNER BUDGET IS DERIVED FROM `MINK_INPUT_FILES`, not restated
 * beside it. A literal 15 here is the same defect waiting for the next time
 * the file cap moves; expressing it as whole sends makes the relationship the
 * thing that is maintained. Three, not two, so a full send plus a full retry
 * still leaves a spare attempt.
 *
 * ⚠ THE STORE AND GLOBAL CEILINGS ARE DELIBERATELY UNCHANGED, and they are a
 * real tightening in MESSAGE terms: 30 files an hour was 30 attachment
 * messages and is now six five-file ones. That is a spend decision rather than
 * a defect — no single legal action can exhaust them, so a retry always fits —
 * and raising them multiplies the worst-case provider bill per store by five.
 * Raise `STORE_FILES_PER_HOUR` / `STORE_FILES_PER_DAY` if the ceiling, not the
 * average, turns out to bite.
 */
const OWNER_SENDS_PER_MINUTE = 3;
const OWNER_FILES_PER_MINUTE = OWNER_SENDS_PER_MINUTE * MINK_INPUT_FILES;
const STORE_FILES_PER_HOUR = 30;
const STORE_FILES_PER_DAY = 100;
const GLOBAL_FILES_PER_HOUR = 500;

/**
 * ★★ VOICE HAS ITS OWN BUCKETS. Dictation and voice chat spent these file
 * buckets, one slot per recording, so a few minutes of talking used up the
 * store's 30 attachments for the hour and then voice and attachments were
 * both refused, for everyone on the store. A conversation is a recording
 * every few seconds, which is a different shape of use from a file someone
 * attaches, so it gets ceilings sized for it.
 * ★ The owner bucket fits a fast back-and-forth (a turn every few seconds,
 * plus the bursts that turn out to hold no words); the store and day ceilings
 * are a spend cap on the transcription provider, which bills per second of
 * audio (each clip is at most 30 seconds). ⚠ These numbers are a spend
 * decision, not a measurement: revisit them on real use.
 */
const VOICE_OWNER_PER_MINUTE = 20;
const VOICE_STORE_PER_HOUR = 300;
const VOICE_STORE_PER_DAY = 1_000;
const VOICE_GLOBAL_PER_HOUR = 5_000;

/**
 * ★ THE HELP CENTRE'S VOICE IS PUBLIC, SO ITS BUCKETS ARE PER VISITOR AND
 * TIGHTER. Nobody signs in to help.storemink.com, so the only key there is the
 * client address (`lib/client-ip.ts`), and the platform-wide ceiling is what
 * bounds the provider bill if many addresses arrive at once. A spoken
 * question every few seconds still fits the minute; an afternoon of it does
 * not fit the hour. ⚠ Spend decisions, like the merchant numbers above.
 */
const HELP_VOICE_VISITOR_PER_MINUTE = 8;
const HELP_VOICE_VISITOR_PER_HOUR = 60;
const HELP_VOICE_GLOBAL_PER_HOUR = 1_000;

type Limit = [key: string, max: number, windowSeconds: number];

/**
 * Claims every limit in order and throws `refusal()` at the first one that is
 * full. Fixed-cardinality quotas come before the replay key, so a caller over
 * quota cannot create unbounded replay-key rows by supplying fresh request
 * UUIDs. Fails closed: a database error is a refusal, never a pass.
 */
async function reserveLimits(limits: Limit[], refusal: () => Error) {
  for (const [key, max, seconds] of limits) {
    const allowed = await withService(async (db) => {
      const result = await db.execute(
        sql`select check_rate_limit(p_key => ${key}, p_max => ${max}, p_window_seconds => ${seconds}) as allowed`,
      );
      return (
        (result.rows[0] as { allowed?: boolean } | undefined)?.allowed === true
      );
    });
    if (!allowed) throw refusal();
  }
}

/** Fail closed before decoding or calling Vertex; shared across Cloud Run instances. */
export async function reserveMinkInput(
  actor: MinkActorContext,
  requestKey: string,
) {
  await reserveLimits(
    [
      [
        `mink-input-owner:${actor.storeId}:${actor.adminId}`,
        OWNER_FILES_PER_MINUTE,
        60,
      ],
      [`mink-input-store:${actor.storeId}`, STORE_FILES_PER_HOUR, 3600],
      [`mink-input-day:${actor.storeId}`, STORE_FILES_PER_DAY, 86400],
      ["mink-input-global", GLOBAL_FILES_PER_HOUR, 3600],
      [
        `mink-input-replay:${actor.storeId}:${actor.adminId}:${requestKey}`,
        1,
        3600,
      ],
    ],
    () =>
      new MinkRequestError(
        "input_rate_limit",
        "This processing request was already used, or the input limit was reached. Wait before explicitly trying again.",
        429,
      ),
  );
}

/**
 * One transcription, for dictation or voice chat: its own buckets (above),
 * never the attachment ones. The message is shown as it is in the composer
 * and in voice chat, so it says what to do in the merchant's words.
 */
export async function reserveMinkVoice(
  actor: MinkActorContext,
  requestKey: string,
) {
  await reserveLimits(
    [
      [
        `mink-voice-owner:${actor.storeId}:${actor.adminId}`,
        VOICE_OWNER_PER_MINUTE,
        60,
      ],
      [`mink-voice-store:${actor.storeId}`, VOICE_STORE_PER_HOUR, 3600],
      [`mink-voice-day:${actor.storeId}`, VOICE_STORE_PER_DAY, 86400],
      ["mink-voice-global", VOICE_GLOBAL_PER_HOUR, 3600],
      [
        `mink-voice-replay:${actor.storeId}:${actor.adminId}:${requestKey}`,
        1,
        3600,
      ],
    ],
    () =>
      new MinkRequestError(
        "voice_rate_limit",
        "Voice has reached its limit for now. Try again a little later, or type your message.",
        429,
      ),
  );
}

/**
 * One transcription for the public Help Centre assistant, keyed by the
 * visitor's address (nobody signs in there). Same fail-closed rule and the
 * same replay key as the dashboard's, so a retried request cannot spend twice.
 */
export async function reserveHelpVoice(ip: string, requestKey: string) {
  await reserveLimits(
    [
      [`help-voice-visitor:${ip}`, HELP_VOICE_VISITOR_PER_MINUTE, 60],
      [`help-voice-visitor-hour:${ip}`, HELP_VOICE_VISITOR_PER_HOUR, 3600],
      ["help-voice-global", HELP_VOICE_GLOBAL_PER_HOUR, 3600],
      [`help-voice-replay:${ip}:${requestKey}`, 1, 3600],
    ],
    () =>
      new MinkRequestError(
        "voice_rate_limit",
        "Voice has reached its limit for now. Try again a little later, or type your question.",
        429,
      ),
  );
}
