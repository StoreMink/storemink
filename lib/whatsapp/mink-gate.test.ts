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

  it("★★ goods that did not come are a complaint, with any apostrophe or none", () => {
    for (const q of [
      // A straight apostrophe, and the question forms.
      "My order wasn't delivered",
      "It hasn't arrived yet",
      "I didn't get my parcel",
      "The parcel hasn't been delivered",
      "It won't arrive in time for the party",
      "I can't receive my order",
      "The mixer isn't working",
      "Why hasn't my order arrived?",
      "Why didn't I receive my order?",
      // Every other apostrophe a keyboard types.
      "My order wasn’t delivered",
      "It hasn‘t arrived",
      "I didnʼt receive it",
      "It wasn`t delivered",
      "It hasn´t come yet",
      "The parcel didn′t arrive",
      "It hasn＇t arrived",
      // None, a space for one, and one typed a letter early.
      "wasnt delivered",
      "still havent received my order",
      "it doesnt work",
      "it wasn t delivered",
      "it did'nt arrive",
      "my order is’nt delivered",
      // Spelled out, and the shorthand people type.
      "I did not get my order",
      "I cannot get my order",
      "Nothing has arrived yet",
      "dint receive the parcel",
    ]) {
      expect(minkGate(q), q).toMatchObject({ ok: false, reason: "complaint" });
    }
  });

  it("★★ and in Hinglish and Hindi, with the negation before or after the verb", () => {
    for (const q of [
      "order mila nahi",
      "nahi mila abhi tak",
      "mera parcel abhi tak nahi aaya",
      "aaya hi nahi",
      "parcel pohcha nahi",
      "nhi pahuncha",
      "delivery nahi hui",
      "मेरा ऑर्डर आया नहीं",
      "पार्सल मिला नहीं।",
      "अभी तक नहीं आया॥",
      "ऑर्डर पहुँचा ही नहीं",
      "मेरा पार्सल नहीं पहुंचा",
      "डिलीवरी नहीं हुई",
    ]) {
      expect(minkGate(q), q).toMatchObject({ ok: false, reason: "complaint" });
    }
  });

  it("★ a negation is not a complaint on its own", () => {
    for (const q of [
      // The policy question stays a question, with either apostrophe.
      "Can I return the cookies if I don't like them?",
      "Can I return the cookies if I don’t like them?",
      // "no" is how an order number is written, and an answer.
      "Status of order no. 1234 please",
      "Where is order no 1234",
      "No it arrived yesterday, so when is the sale?",
      "I don’t know which size to pick",
      "Is it not too sweet for kids?",
      // "I didn't understand" uses the verb for arriving.
      "samajh nahi aaya, phir se batao",
      "मुझे समझ नहीं आया, फिर से बताइए",
      "मुझे नहीं पता कौन सा लूं",
      // ★ A danda ends a sentence: "Got the parcel. No, nothing else."
      "पार्सल मिला। नहीं, और कुछ नहीं चाहिए",
      "Kab tak mil jayega?",
    ]) {
      expect(minkGate(q), q).toEqual({ ok: true });
    }
  });

  it("a danda is a full stop, so a Hindi pleasantry stays one", () => {
    for (const q of ["ठीक है।", "धन्यवाद॥", "ठीक है। धन्यवाद।"]) {
      expect(minkGate(q), q).toMatchObject({ ok: false, reason: "greeting" });
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

  it("★ a message with no words (an emoji, a lone '?') is not a question", () => {
    for (const q of ["👍", "🙏🙏", "?", "...", "😊 👍"]) {
      expect(minkGate(q)).toMatchObject({ ok: false, reason: "greeting" });
    }
  });

  it("★ pleasantries of several words are judged word by word", () => {
    for (const q of [
      "ok thanks",
      "Ok, thanks!",
      "thank you so much",
      "Thank you very much 🙏",
      "hi there",
      "Hello sir",
      "thanks a lot",
      "great, thanks",
      "no thanks",
      "ok noted",
      "see you later",
      "thanks for your help",
      "theek hai",
      "ok ji",
      "ठीक है",
      "बहुत धन्यवाद",
    ]) {
      expect(minkGate(q)).toMatchObject({ ok: false, reason: "greeting" });
    }
  });

  it("★★ one real word makes it a question, however polite the rest", () => {
    for (const q of [
      "thanks, where is my order",
      "ok what is the price of the almond shake",
      "thank you, can I get it by Friday?",
      "hello is the oat cookie in stock",
      "hi there, any offers today?",
      "yes please",
      "help me choose a gift",
      "560001",
    ]) {
      expect(minkGate(q)).toEqual({ ok: true });
    }
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
