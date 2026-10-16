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

  it("★ a danda ends a Hindi sentence like a full stop", () => {
    // The Devanagari block holds । and ॥ beside its letters; kept, they
    // glued onto the last word and "बंद करो।" was not an opt-out.
    expect(classifyWhatsAppInbound("बंद करो।")).toBe("stop");
    expect(classifyWhatsAppInbound("बंद करो॥")).toBe("stop");
    expect(classifyWhatsAppInbound("बंद।")).toBe("stop");
    expect(classifyWhatsAppInbound("कृपया मत भेजो।")).toBe("stop");
    expect(classifyWhatsAppInbound("शुरू करो।")).toBe("start");
    expect(classifyWhatsAppInbound("मेनू।")).toBe("menu");
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

  it("★ a negation goes to a person however its apostrophe is typed", () => {
    // Each would be a status question without its negation; answering one
    // with "Delivered on 12 Oct" would dismiss the complaint.
    for (const body of [
      "my order wasn't delivered",
      "my order wasn’t delivered",
      "my order wasnʼt delivered",
      "My order wasnt delivered",
      "my order wasn t delivered",
      "my order hasn't shipped yet",
      "why hasnt my order shipped",
      "my order isn't delivered yet",
      "my order won't arrive?",
      "my order won’t arrive",
      "why doesn't my order show tracking",
      "my orders aren't delivered",
      "I can't track my order",
      "cannot track my order",
      "I don't know where my order is",
      "nobody delivered my order",
      "still nothing, where is my order",
      // The apostrophe a letter early, and chat shorthand.
      "my order did'nt arrive",
      "my order is’nt delivered",
      "order dint arrive",
      "order dnt come yet where is it",
      "i havnt got my order",
      "hvnt received my order",
    ]) {
      expect(classifyWhatsAppInbound(body), body).toBe("other");
    }
  });

  it("★ the Hindi negations hold under a danda and in chat spelling", () => {
    for (const body of [
      "मेरा ऑर्डर कहाँ है? अभी तक आया नहीं।",
      "ऑर्डर कब आएगा? अभी तक आया नहीँ",
      "mera order kahan hai, abhi tak nai aaya",
    ]) {
      expect(classifyWhatsAppInbound(body), body).toBe("other");
    }
  });

  it("'can' and an order 'no.' are not negations: still a status question", () => {
    for (const body of [
      "when can I expect my order",
      "can you track my order",
      "Order no. 1234 status",
      "order no 1234 kab aayega",
    ]) {
      expect(classifyWhatsAppInbound(body), body).toBe("order_status");
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

describe("classifyWhatsAppInbound: asking for the menu", () => {
  it("reads a short request for the menu, with courtesy words and punctuation", () => {
    for (const body of [
      "menu",
      "Menu!",
      "options",
      "main menu",
      "show menu please",
      "help",
      "menu dikhao",
      "मेनू",
    ]) {
      expect(classifyWhatsAppInbound(body), body).toBe("menu");
    }
  });

  it("★ a sentence that merely contains the word is not a request", () => {
    for (const body of [
      "the menu button does nothing",
      "do you have a menu for catering",
      "help me cancel my order",
    ]) {
      expect(classifyWhatsAppInbound(body), body).not.toBe("menu");
    }
  });
});
