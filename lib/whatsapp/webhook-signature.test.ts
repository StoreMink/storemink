import crypto from "crypto";
import { describe, expect, it } from "vitest";
import {
  answerVerifyChallenge,
  verifyMetaSignature,
} from "./webhook-signature";

const SECRET = "app-secret-123";

function sign(body: string, secret = SECRET) {
  return (
    "sha256=" +
    crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")
  );
}

describe("verifyMetaSignature", () => {
  const body = '{"object":"whatsapp_business_account","entry":[]}';

  it("accepts a correctly signed raw body", () => {
    expect(verifyMetaSignature(SECRET, body, sign(body))).toEqual({ ok: true });
  });

  it("rejects a body signed with another secret", () => {
    expect(verifyMetaSignature(SECRET, body, sign(body, "other"))).toEqual({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("rejects a body that changed after signing — including a re-serialised one", () => {
    // Meta escapes non-ASCII before signing; a parse + stringify round trip
    // changes the bytes. The verifier must see the raw body or this fails.
    const raw = '{"object":"whatsapp_business_account","x":"caf\\u00e9"}';
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(verifyMetaSignature(SECRET, raw, sign(raw))).toEqual({ ok: true });
    expect(verifyMetaSignature(SECRET, reserialised, sign(raw)).ok).toBe(false);
  });

  it("refuses without throwing on a missing, malformed or short header", () => {
    expect(verifyMetaSignature(SECRET, body, null)).toEqual({
      ok: false,
      reason: "missing signature header",
    });
    expect(verifyMetaSignature(SECRET, body, "md5=abc")).toEqual({
      ok: false,
      reason: "malformed signature header",
    });
    // A wrong-length digest would make timingSafeEqual THROW; it must not.
    expect(verifyMetaSignature(SECRET, body, "sha256=abcd")).toEqual({
      ok: false,
      reason: "signature mismatch",
    });
  });

  it("refuses everything when no secret is configured", () => {
    expect(verifyMetaSignature("", body, sign(body, "")).ok).toBe(false);
  });
});

describe("answerVerifyChallenge", () => {
  const params = (q: Record<string, string>) => new URLSearchParams(q);

  it("echoes the challenge when mode and token match", () => {
    expect(
      answerVerifyChallenge(
        params({
          "hub.mode": "subscribe",
          "hub.verify_token": "tok",
          "hub.challenge": "12345",
        }),
        "tok",
      ),
    ).toBe("12345");
  });

  it("refuses a wrong token, a wrong mode, a missing challenge and no configured token", () => {
    const good = {
      "hub.mode": "subscribe",
      "hub.verify_token": "tok",
      "hub.challenge": "1",
    };
    expect(
      answerVerifyChallenge(
        params({ ...good, "hub.verify_token": "nope" }),
        "tok",
      ),
    ).toBeNull();
    expect(
      answerVerifyChallenge(
        params({ ...good, "hub.mode": "unsubscribe" }),
        "tok",
      ),
    ).toBeNull();
    expect(
      answerVerifyChallenge(
        params({ "hub.mode": "subscribe", "hub.verify_token": "tok" }),
        "tok",
      ),
    ).toBeNull();
    expect(answerVerifyChallenge(params(good), "")).toBeNull();
  });
});
