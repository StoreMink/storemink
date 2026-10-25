import "server-only";

import { can } from "@/app/dashboard/lib/permissions";
import { logError } from "@/lib/observability/logger";
import {
  MinkRequestError,
  MinkToolInputError,
  MinkToolTimeoutError,
} from "../errors";
import type {
  MinkActorContext,
  MinkToolCall,
  MinkToolDeclaration,
  MinkArtifact,
  MinkToolPermission,
  MinkToolResponse,
} from "../types";

/**
 * What a tool is given beside the actor and its arguments: its deadline.
 *
 * ★★ A TIMEOUT NOW STOPS THE WORK (B6, 2026-10-23). The registry used to race
 *    a tool against a timer and walk away when the timer won, leaving the
 *    tool running: an image could be drawn, saved and charged after the chat
 *    had told the merchant it took too long, with no card to show for it, and
 *    a redesign could start after "took too long". Now the timer fires
 *    `signal`, which a tool hands to every provider call and checks before
 *    every write, and `commit` keeps the last write and the chat's answer in
 *    agreement.
 */
export interface MinkToolContext {
  /**
   * Fires when the tool's time is up (`timeoutMs`), or sooner when the run
   * itself is stopped and its signal was passed to `execute`.
   */
  signal: AbortSignal;
  /** The epoch millisecond at which `signal` fires at the latest. */
  deadlineAt: number;
  /**
   * Run the tool's final write, the one that charges the merchant or keeps
   * what they will be shown, only while time remains: once the time is up it
   * throws `MinkToolTimeoutError` without running `write`. ★ A write already
   *   under way when the time runs out holds the timeout (for at most
   *   `TOOL_COMMIT_GRACE_MS` more), and the tool's result is returned, so the
   *   chat never reports a timeout for a card that was saved and charged.
   * ⚠ Keep it the LAST thing a tool does: work after it is still bounded by
   *   the grace, but nothing else waits for it.
   */
  commit<T>(write: () => Promise<T>): Promise<T>;
}

/**
 * How long a write a tool began before its deadline may run past it before
 * the registry reports the timeout anyway. Bounded so a stuck database cannot
 * hold a run open.
 *
 * ★★ IT COVERS THE WRITE'S OWN BOUNDED WORST CASE, NOT A TYPICAL ONE (the
 *   money review of B6). A commit is a few separate transactions (the image
 *   tool's: the Media row, the credit cycle and allowance reads, then the
 *   charged draft), and since B27 each may wait up to 5 s for a connection and
 *   hold a statement up to 30 s on a lock. With 15 s a write still landing
 *   after the grace charged the merchant for a card the chat had already
 *   called a timeout, and a run that then failed could discard its drafts
 *   before that one landed. A minute holds the realistic worst (a connection
 *   wait per transaction and one statement waiting on a lock); a write that
 *   outlives even that is logged (`mink.tool: write outlived its grace`) so an
 *   operator can give the charge back. Measured writes take well under a
 *   second, so the grace costs nothing on an ordinary run.
 */
export const TOOL_COMMIT_GRACE_MS = 60_000;

export interface MinkTool {
  declaration: MinkToolDeclaration;
  /**
   * A declaration narrowed to what THIS actor can actually satisfy.
   *
   * ★ IT EXISTS FOR REQUIRED ARGUMENTS THE ACTOR CANNOT OBTAIN. A tool is
   *   offered on its own permission, but an argument may only be produceable
   *   by a DIFFERENT tool behind a DIFFERENT permission - and declaring that
   *   argument required then guarantees the call fails for a role that is
   *   otherwise entitled to the tool. `propose_blog_draft` is the case: every
   *   cover URL comes from `list_storefront_media` (media:view),
   *   `generate_storefront_image` (media:manage) or the catalogue reads
   *   (products:view), so for a blogs:manage-only admin a mandatory
   *   `cover_image_url` is an argument nothing on the platform can give them.
   *
   * ⚠ IT MUST NOT CHANGE THE NAME - the registry is keyed on
   *   `declaration.name`, so a renamed variant would be unroutable. And it is
   *   NOT an authorization boundary: `execute` still re-derives every rule
   *   from the actor, exactly as it does for tool visibility.
   */
  declarationFor?: (actor: MinkActorContext) => MinkToolDeclaration;
  permission: MinkToolPermission;
  timeoutMs: number;
  /**
   * A successful human-review artifact that is sufficient to finish the run
   * without asking the model for one more prose-only turn.
   *
   * This is an opt-in escape hatch for a final tool call the model has already
   * selected on the configured last reasoning turn. Keep it off reads, image
   * generation, workflows and live actions: those may still need another tool
   * or a model explanation, and running them at the cap could spend money or
   * mutate state before reporting a failed run.
   */
  stepLimitCompletionText?: string;
  /**
   * A PURE read: calling it twice with the same arguments inside one run
   * returns the same thing and changes nothing. The orchestrator serves the
   * second call from its per-run memo instead of spending tool budget on it.
   *
   * ⚠ OPT-IN, and it must stay opt-in. The default has to be "not safe", or a
   * tool added later silently becomes de-duplicable — and the ones that are
   * NOT safe here are the ones that queue a durable workflow, create a
   * proposal, or spend money on an image.
   */
  repeatSafe?: boolean;
  /**
   * Running it twice in one request does no harm, though a repeat must still
   * reach the client (so it is not `repeatSafe`). A narrowed run that has
   * called only repeat-safe or restart-safe tools may restart with every tool
   * (`request_more_tools`); one that has run anything else may not, or the
   * restart would save, queue or pay for it a second time.
   *
   * ⚠ OPT-IN for `repeatSafe`'s reason: the default must be "not safe".
   */
  restartSafe?: boolean;
  /**
   * How long the run may still take once this tool has started: the stream
   * route pushes the run's deadline out to at least this far ahead, never
   * pulls it in. For a tool that does a long piece of work of its own (the
   * storefront personalisation writes a whole site and draws its photos), so
   * the ordinary run deadline does not cut it off half way. Bounded at five
   * minutes by `MAX_RUN_BUDGET_MS`.
   */
  runBudgetMs?: number;
  available?: (actor: MinkActorContext) => boolean;
  artifact?: (output: Record<string, unknown>) => MinkArtifact | undefined;
  /**
   * What the MODEL is sent, when that is less than the whole output. The
   * output still reaches `artifact` whole; only the function response the
   * model reads (and re-sends on every later step) is narrowed. ★ For a tool
   * whose card carries figures the model must not quote, such as a charge,
   * keeping them out of its context is the boundary, not the prompt.
   */
  modelOutput?: (output: Record<string, unknown>) => Record<string, unknown>;
  /**
   * ★ `context` is always given by the registry; it is optional only so a
   *   test may call a tool directly. A tool that pays for or writes anything
   *   honours `context.signal` and makes its last write through
   *   `context.commit`.
   */
  execute: (
    actor: MinkActorContext,
    args: Record<string, unknown>,
    context?: MinkToolContext,
  ) => Promise<Record<string, unknown>>;
}

/** The longest a tool may stretch its run, so a mistake cannot hold a request open. */
export const MAX_RUN_BUDGET_MS = 300_000;

export class MinkToolRegistry {
  private readonly tools: Map<string, MinkTool>;

  constructor(tools: MinkTool[]) {
    this.tools = new Map();
    for (const tool of tools) {
      const name = tool.declaration.name;
      if (this.tools.has(name)) throw new Error(`Duplicate Mink tool: ${name}`);
      this.tools.set(name, tool);
    }
  }

  /** Whether a repeated identical call may be served from a per-run memo. */
  isRepeatSafe(name: string): boolean {
    return this.tools.get(name)?.repeatSafe === true;
  }

  /**
   * Whether running this tool again in a restarted attempt is harmless. A
   * name the registry does not know ran nothing, so it is.
   */
  isRestartSafe(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return true;
    return tool.repeatSafe === true || tool.restartSafe === true;
  }

  /** See `MinkTool.runBudgetMs`; undefined for an ordinary tool. */
  runBudgetMs(name: string): number | undefined {
    const budget = this.tools.get(name)?.runBudgetMs;
    if (!budget || !Number.isFinite(budget) || budget <= 0) return undefined;
    return Math.min(budget, MAX_RUN_BUDGET_MS);
  }

  /** Deterministic success copy for an explicitly safe last-turn finalizer. */
  stepLimitCompletionText(name: string): string | undefined {
    return this.tools.get(name)?.stepLimitCompletionText;
  }

  declarationsFor(actor: MinkActorContext): MinkToolDeclaration[] {
    return [...this.tools.values()]
      .filter((tool) => this.allowed(actor, tool))
      .map((tool) => tool.declarationFor?.(actor) ?? tool.declaration);
  }

  async execute(
    actor: MinkActorContext,
    call: MinkToolCall,
    options: {
      /**
       * The run's own stop (its deadline, the merchant leaving). ★ When given,
       *   it fires the tool's signal too, so a stopped run stops its tools.
       */
      signal?: AbortSignal;
    } = {},
  ): Promise<MinkToolResponse> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return failure(call, "unknown_tool", "That tool is not available.");
    }
    // The model only sees permitted declarations, but this check is the real
    // boundary. Never rely on tool visibility as authorization.
    if (!this.allowed(actor, tool)) {
      return failure(
        call,
        "permission_denied",
        "The current admin is not allowed to use this tool.",
      );
    }

    try {
      const output = await executeWithDeadline(
        (context) => tool.execute(actor, call.args, context),
        tool.timeoutMs,
        options.signal,
        {
          requestId: actor.requestId,
          storeId: actor.storeId,
          adminId: actor.adminId,
          tool: call.name,
        },
      );
      const artifact = tool.artifact?.(output);
      return {
        id: call.id,
        name: call.name,
        response: {
          output: tool.modelOutput ? tool.modelOutput(output) : output,
        },
        ...(artifact ? { artifact } : {}),
      };
    } catch (error) {
      if (error instanceof MinkToolInputError) {
        return failure(call, "invalid_tool_input", error.message);
      }
      if (error instanceof MinkToolTimeoutError) {
        return failure(
          call,
          "tool_timeout",
          "The Mink AI tool took too long. Try a narrower request.",
        );
      }
      // ★★ A `MinkRequestError` CARRIES AN AUTHOR-WRITTEN, MERCHANT-SAFE
      //    SENTENCE - it is the same text the HTTP routes return - and the
      //    catch-all below replaced every one of them with "could not finish
      //    right now". That is the difference between the model rephrasing
      //    "choose another image and try again" and it retrying the same
      //    failing input until the run's tool budget is gone. Only the
      //    MESSAGE is forwarded; the code stays in this file's own closed
      //    vocabulary, and anything unrecognised still falls through to the
      //    generic text so no database or stack detail can reach the model.
      if (error instanceof MinkRequestError) {
        logError("mink.tool: request failed", error, {
          requestId: actor.requestId,
          storeId: actor.storeId,
          adminId: actor.adminId,
          tool: call.name,
        });
        return failure(call, "tool_failed", error.message);
      }
      logError("mink.tool: failed", error, {
        requestId: actor.requestId,
        storeId: actor.storeId,
        adminId: actor.adminId,
        tool: call.name,
      });
      // Do not put database or stack details back into the model context.
      return failure(
        call,
        "tool_failed",
        "The Mink AI tool could not finish right now.",
      );
    }
  }

  private allowed(actor: MinkActorContext, tool: MinkTool): boolean {
    return (
      (tool.available?.(actor) ?? true) &&
      can(
        actor.permissions,
        tool.permission.section,
        tool.permission.action,
        actor.isSuperadmin,
      )
    );
  }
}

/**
 * Run one tool under its deadline. ★ The deadline is a STOP, not only a
 * stopwatch: when it passes, the tool's signal fires (aborting its provider
 * calls) and the registry answers `tool_timeout`. A write the tool began
 * through `commit` before then is allowed to finish (up to
 * `TOOL_COMMIT_GRACE_MS`), and its result is what the registry answers.
 */
async function executeWithDeadline<T>(
  operation: (context: MinkToolContext) => Promise<T>,
  timeoutMs: number,
  runSignal?: AbortSignal,
  /** Content-free ids for the one log line below. */
  logContext: Record<string, unknown> = {},
): Promise<T> {
  const stop = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  // Set once the time is up: no write may start after it.
  let expired = false;
  // Writes under way, and whether one has completed.
  let writing = 0;
  let wrote = false;
  let reportTimeout!: (error: MinkToolTimeoutError) => void;
  const timedOut = new Promise<never>((_, reject) => {
    reportTimeout = reject;
  });
  let grace: ReturnType<typeof setTimeout> | undefined;
  const halt = () => {
    // ★ A write still under way when the grace runs out may yet land, and
    //   charge for a card the chat is about to call a timeout: rare (see
    //   TOOL_COMMIT_GRACE_MS), and never silent.
    if (writing > 0) {
      logError("mink.tool: write outlived its grace", undefined, {
        ...logContext,
        graceMs: TOOL_COMMIT_GRACE_MS,
      });
    }
    // ★ The timeout is reported BEFORE the signal fires: aborting runs the
    //   tool's listeners at once, and a tool that rejects on its signal would
    //   otherwise settle the race first and read as "could not finish".
    reportTimeout(new MinkToolTimeoutError());
    if (!stop.signal.aborted) stop.abort(new MinkToolTimeoutError());
  };
  const expire = () => {
    if (expired) return;
    expired = true;
    // ★ A write under way, or done, stands: the merchant must be shown what
    //   they were charged for. It gets the grace, then the timeout regardless.
    if (writing > 0 || wrote) {
      grace = setTimeout(halt, TOOL_COMMIT_GRACE_MS);
      return;
    }
    halt();
  };
  const timer = setTimeout(expire, timeoutMs);
  const onRunStop = () => expire();
  if (runSignal?.aborted) expire();
  else runSignal?.addEventListener("abort", onRunStop, { once: true });

  const context: MinkToolContext = {
    signal: stop.signal,
    deadlineAt,
    async commit(write) {
      if (expired || stop.signal.aborted) throw new MinkToolTimeoutError();
      writing += 1;
      try {
        const result = await write();
        wrote = true;
        return result;
      } finally {
        writing -= 1;
      }
    },
  };
  try {
    if (expired) await timedOut;
    return await Promise.race([operation(context), timedOut]);
  } finally {
    clearTimeout(timer);
    if (grace) clearTimeout(grace);
    runSignal?.removeEventListener("abort", onRunStop);
  }
}

function failure(
  call: MinkToolCall,
  code: string,
  message: string,
): MinkToolResponse {
  return {
    id: call.id,
    name: call.name,
    response: { error: { code, message } },
  };
}
