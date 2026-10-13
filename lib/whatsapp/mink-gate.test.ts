// ---------------------------------------------------------------------------
// The deterministic gate in front of customer-facing Mink: what never reaches
// a model, in three scripts, and what does.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { MINK_QUESTION_MAX_CHARS, minkGate } from "./mink-gate";

describe("minkGate", () => {
  it("lets an ordinary question through", () => {
    for (const q of [
      "Do you have the almond shake in 500 ml?",
      "What time do you open on Sunday?",
      "Can you deliver to 560001?",
      "Kya aapke paas blue wala hai?",
      "आपकी दुकान कितने बजे खुलती है?",
      "Is the Diwali offer still on",
      "where is my order",
      "price of the oat cookies",
      // A question about the return policy is one the facts carry.
      "Can I return the cookies if I don't like them?",
      "What is your return policy?",
    ]) {
      expect(minkGate(q)).toEqual({ ok: true });
    }
  });

  it("★ a return of goods in hand is a person's; a return question is not", () => {
    for (const q of [
      "I want to return my order",
      "returning this parcel, how?",
      "need to return the package I got",
    ]) {
      expect(minkGate(q)).toMatchObject({ ok: false, reason: "complaint" });
    }
  });

  it("★ a complaint, a refund, a return or a damaged parcel is a person's, in any script", () => {
    for (const q of [
      "I want a refund",
      "The bottle arrived broken",
      "Wrong item delivered",
      "My order was not delivered",
      "I haven't received my parcel",
      "This is a scam",
      "mujhe refund chahiye",
      "product kharab nikla",
      "galat item aaya hai",
      "मेरा ऑर्डर नहीं मिला",
      "रिफंड चाहिए",
    ]) {
      expect(minkGate(q)).toMatchObject({ ok: false, reason: "complaint" });
    }
  });

  it("★ a change to an order, and money gone wrong, go to a person", () => {
    expect(minkGate("Cancel my order please")).toMatchObject({
      ok: false,
      reason: "order_change",
    });
    expect(minkGate("I need to change my address")).toMatchObject({
      ok: false,
      reason: "order_change",
    });
    expect(minkGate("ऑर्डर कैंसिल करना है")).toMatchObject({
      ok: false,
      reason: "order_change",
    });
    expect(minkGate("payment failed but money deducted")).toMatchObject({
      ok: false,
      reason: "payment",
    });
    expect(minkGate("paise kat gaye")).toMatchObject({
      ok: false,
      reason: "payment",
    });
  });

  it("★ asking for a person is answered by a person", () => {
    for (const q of [
      "Can I talk to a human?",
      "connect me to someone",
      "I want to speak to the owner",
      "call me",
      "kisi se baat karni hai",
      "किसी से बात करनी है",
    ]) {
      expect(minkGate(q)).toMatchObject({ ok: false, reason: "person" });
    }
  });

  it("a bare greeting or thanks is not a question", () => {
    for (const q of [
      "hi",
      "Hello!",
      "ok",
      "thanks",
      "नमस्ते",
      "Good morning",
    ]) {
      expect(minkGate(q)).toMatchObject({ ok: false, reason: "greeting" });
    }
    // A greeting followed by a question is a question.
    expect(minkGate("Hi, do you deliver to Pune?")).toEqual({ ok: true });
  });

  it("empty and over-long messages are kept for a person", () => {
    expect(minkGate("")).toMatchObject({ ok: false, reason: "empty" });
    expect(minkGate("   ")).toMatchObject({ ok: false, reason: "empty" });
    expect(minkGate(null)).toMatchObject({ ok: false, reason: "empty" });
    expect(minkGate("a".repeat(MINK_QUESTION_MAX_CHARS + 1))).toMatchObject({
      ok: false,
      reason: "too_long",
    });
  });

  it("★ money and complaints win over a greeting in the same message", () => {
    expect(minkGate("hi, cancel my order")).toMatchObject({
      ok: false,
      reason: "order_change",
    });
    expect(minkGate("thanks but it arrived damaged")).toMatchObject({
      ok: false,
      reason: "complaint",
    });
  });
});
