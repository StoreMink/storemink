import { describe, expect, it } from "vitest";

import { readMinkStopResult } from "./run-stop-types";

describe("readMinkStopResult", () => {
  it("reads each answer the stop route sends", () => {
    expect(readMinkStopResult({ outcome: "stopped" })).toEqual({
      outcome: "stopped",
    });
    expect(readMinkStopResult({ outcome: "acted" })).toEqual({
      outcome: "acted",
    });
    expect(readMinkStopResult({ outcome: "finished" })).toEqual({
      outcome: "finished",
    });
    for (const status of ["succeeded", "failed", "cancelled"] as const) {
      expect(readMinkStopResult({ outcome: "finished", status })).toEqual({
        outcome: "finished",
        status,
      });
    }
  });

  it("drops a status it does not know rather than passing it on", () => {
    expect(
      readMinkStopResult({ outcome: "finished", status: "running" }),
    ).toEqual({ outcome: "finished" });
  });

  it("★ never reads anything but an explicit stopped as stopped", () => {
    // Letting go of a reply the server is still producing is the failure the
    // stop route exists to prevent, so every malformed answer keeps reading.
    for (const value of [
      null,
      undefined,
      "stopped",
      ["stopped"],
      {},
      { outcome: "STOPPED" },
      { outcome: "stop" },
      { outcome: "not_found" },
      { stopped: true },
    ]) {
      expect(readMinkStopResult(value)).toEqual({ outcome: "unknown" });
    }
  });
});
