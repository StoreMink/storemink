import { describe, expect, it } from "vitest";
import { classifyWhatsAppInbound } from "./inbox-intent";

describe("classifyWhatsAppInbound", () => {
  it("reads the plain opt-out words, in any case, with punctuation", () => {
    for (const body of ["STOP", "stop.", "Unsubscribe", "opt-out", "Stop!!"]) {
      expect(classifyWhatsAppInbound(body), body).toBe("stop");
    }
  });

  it("tolerates a courtesy word and nothing more", () => {
    expect(classifyWhatsAppInbound("please stop")).toBe("stop");
    expect(classifyWhatsAppInbound("stop please 🙏")).toBe("stop");
    expect(classifyWhatsAppInbound("kindly unsubscribe me")).toBe("stop");
    // A sentence is a complaint or a question, not an opt-out.
    expect(classifyWhatsAppInbound("stop sending me the wrong size")).toBe(
      "other",
    );
  });

  it("★ 'cancel' is NOT an opt-out on WhatsApp — it is about an order", () => {
    expect(classifyWhatsAppInbound("cancel")).toBe("other");
    expect(classifyWhatsAppInbound("cancel my order")).toBe("other");
    expect(classifyWhatsAppInbound("end")).toBe("other");
  });

  it("knows Hindi in both scripts", () => {
    expect(classifyWhatsAppInbound("band karo")).toBe("stop");
    expect(classifyWhatsAppInbound("mat bhejo")).toBe("stop");
    expect(classifyWhatsAppInbound("बंद करो")).toBe("stop");
    expect(classifyWhatsAppInbound("रोको")).toBe("stop");
    expect(classifyWhatsAppInbound("कृपया मत भेजो")).toBe("stop");
    expect(classifyWhatsAppInbound("shuru karo")).toBe("start");
    expect(classifyWhatsAppInbound("शुरू करो")).toBe("start");
  });

  it("reads START and its friends", () => {
    expect(classifyWhatsAppInbound("START")).toBe("start");
    expect(classifyWhatsAppInbound("subscribe")).toBe("start");
    expect(classifyWhatsAppInbound("send offers")).toBe("start");
  });

  it("is `other` for everything it is not sure about", () => {
    expect(classifyWhatsAppInbound("")).toBe("other");
    expect(classifyWhatsAppInbound("hi")).toBe("other");
    expect(classifyWhatsAppInbound("is the blue one in stock?")).toBe("other");
    expect(classifyWhatsAppInbound("stop it from leaking")).toBe("other");
  });
});

describe("classifyWhatsAppInbound: where is my order", () => {
  it("★ recognises the question however it is asked", () => {
    for (const body of [
      "Where is my order?",
      "where's my order",
      "Hi, where is my order please",
      "Hello sir where is my parcel",
      "order status",
      "Status",
      "Track my order",
      "tracking id?",
      "when will my order arrive",
      "status of my order",
      "has my order shipped",
      "mera order kahan hai",
      "order kab aayega",
      "kab milega mera parcel",
      "मेरा ऑर्डर कहाँ है",
      "मेरा ऑर्डर कहां है?",
      "ऑर्डर कब आएगा",
    ]) {
      expect(classifyWhatsAppInbound(body), body).toBe("order_status");
    }
  });

  it("★ a complaint or a request goes to a person", () => {
    for (const body of [
      "my order was not delivered",
      "cancel my order",
      "I want to return my order",
      "wrong order received",
      "where is my refund",
      "order abhi tak nahi aaya",
      "मेरा ऑर्डर नहीं आया",
      "can you change the address on my order",
    ]) {
      expect(classifyWhatsAppInbound(body), body).toBe("other");
    }
  });

  it("asking to buy, or about the shop, is not a status question", () => {
    for (const body of [
      "where can I order from",
      "I want to order 2 more",
      "order",
      "my order",
      "do you deliver to Pune",
      "what are the delivery charges",
      "where is your shop",
      "Is the blue one in stock?",
    ]) {
      expect(classifyWhatsAppInbound(body), body).toBe("other");
    }
  });

  it("a long message is a story a person should read", () => {
    expect(
      classifyWhatsAppInbound(
        "where is my order I placed it last week for my sister's wedding on Saturday",
      ),
    ).toBe("other");
  });

  it("STOP and START still win on a short message", () => {
    expect(classifyWhatsAppInbound("stop")).toBe("stop");
    expect(classifyWhatsAppInbound("start")).toBe("start");
  });
});
