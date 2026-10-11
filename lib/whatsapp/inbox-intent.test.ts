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
