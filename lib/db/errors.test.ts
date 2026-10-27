import { describe, expect, it } from "vitest";
import {
  isUniqueViolation,
  loggableError,
  pgConstraint,
  pgErrorCode,
} from "./errors";

describe("pg error helpers", () => {
  it("read the SQLSTATE and the constraint from the error or from its cause", () => {
    const pg = {
      code: "23505",
      constraint: "store_whatsapp_accounts_phone_key",
    };
    // Drizzle 0.45 wraps the pg error in a DrizzleQueryError, on `cause`.
    const wrapped = { message: "Failed query: insert …", cause: pg };
    for (const err of [pg, wrapped]) {
      expect(pgErrorCode(err)).toBe("23505");
      expect(isUniqueViolation(err)).toBe(true);
      expect(pgConstraint(err)).toBe("store_whatsapp_accounts_phone_key");
    }
  });

  it("name no constraint when pg named none", () => {
    expect(pgConstraint(null)).toBeUndefined();
    expect(pgConstraint("boom")).toBeUndefined();
    expect(pgConstraint({ code: "23505" })).toBeUndefined();
    expect(pgConstraint({ constraint: 42 })).toBeUndefined();
  });
});

// ★ B22: what a catch hands logError. A failed query is reduced to the
// database's reason (its own message carries the query's parameters); any
// other Error keeps its stack and its name.
describe("loggableError", () => {
  it("reduces a failed query to the database's reason", () => {
    const failed = Object.assign(
      new Error('Failed query: select $1\nparams: "Secret Almond Shake"'),
      { cause: new Error("deadlock detected") },
    );
    expect(loggableError(failed)).toBe("deadlock detected");
  });

  it("logs any other Error as itself, stack and name", () => {
    const bug = new TypeError("Cannot read properties of undefined");
    expect(loggableError(bug)).toBe(bug);
    const busy = Object.assign(new Error("No database connection came free"), {
      name: "DatabaseBusyError",
    });
    expect(loggableError(busy)).toBe(busy);
  });

  it("never logs a thrown non-Error as itself", () => {
    expect(loggableError({ message: "pool ended" })).toBe("pool ended");
    expect(loggableError({ tagline: "Secret" })).toBe("unknown error");
    expect(loggableError(undefined, "database error")).toBe("database error");
  });
});
