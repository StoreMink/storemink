import { describe, expect, it } from "vitest";
import { isUniqueViolation, pgConstraint, pgErrorCode } from "./errors";

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
