import { describe, expect, it } from "vitest";
import {
  createMinkSpeechSegmenter,
  isEchoTranscript,
  speechCutPoint,
} from "./speech-stream";

describe("speechCutPoint", () => {
  it("cuts after a sentence once the next word has arrived", () => {
    expect(speechCutPoint("Sales are up. Orders", { first: true })).toBe(13);
    expect(speechCutPoint("Sales are up.", { first: true })).toBe(0);
    expect(speechCutPoint("Sales are up. ", { first: true })).toBe(0);
  });

  it("never cuts inside a number, an abbreviation or a lowercase continuation", () => {
    expect(speechCutPoint("Rs. 500 came in", { first: true })).toBe(0);
    expect(speechCutPoint("Rated 4.5 stars. Great", { first: true })).toBe(16);
    expect(speechCutPoint("e.g. this one. Next", { first: true })).toBe(14);
  });

  it("treats the danda and a paragraph break as ends", () => {
    expect(speechCutPoint("आज बारह ऑर्डर आए। कल", { first: false })).toBe(17);
    expect(speechCutPoint("First part\n\nSecond", { first: false })).toBe(10);
  });

  it("★ cuts a long opening sentence at its last clause break", () => {
    const long =
      "Your delivery settings look fine for most of the country, with free delivery above five hundred rupees, but the Delhi warehouse still has no weight on four products";
    const cut = speechCutPoint(long, { first: true });
    expect(cut).toBeGreaterThan(60);
    expect(long.slice(0, cut).endsWith(",")).toBe(true);
    // Not for a later piece, which can wait for its sentence.
    expect(speechCutPoint(long, { first: false })).toBe(0);
    // And not before it has run long.
    expect(speechCutPoint("Short, so far", { first: true })).toBe(0);
  });

  it("backs off while the piece would split emphasis or code", () => {
    expect(speechCutPoint("One. **Two. Three", { first: false })).toBe(4);
    expect(speechCutPoint("One. `code. Two", { first: false })).toBe(4);
  });
});

describe("createMinkSpeechSegmenter", () => {
  it("hands out each completed sentence once as the text grows", () => {
    const segmenter = createMinkSpeechSegmenter();
    expect(segmenter.push("You have twelve")).toEqual({
      pieces: [],
      reset: false,
    });
    expect(segmenter.push("You have twelve orders today. Three")).toEqual({
      pieces: ["You have twelve orders today."],
      reset: false,
    });
    expect(segmenter.push("You have twelve orders today. Three are")).toEqual({
      pieces: [],
      reset: false,
    });
    expect(
      segmenter.push(
        "You have twelve orders today. Three are new. Two need packing. All",
      ),
    ).toEqual({
      pieces: ["Three are new. Two need packing."],
      reset: false,
    });
    expect(segmenter.emitted).toBe(62);
    expect(segmenter.spoke).toBe(true);
  });

  it("★ reads a shrink or a non-prefix replacement as a withdrawal", () => {
    const segmenter = createMinkSpeechSegmenter();
    segmenter.push("Let me check that. One");
    expect(segmenter.push("")).toEqual({ pieces: [], reset: true });
    expect(segmenter.push("Done. The")).toEqual({
      pieces: ["Done."],
      reset: false,
    });
    const batched = createMinkSpeechSegmenter();
    batched.push("Let me check that. One");
    expect(batched.push("Done now. The")).toEqual({
      pieces: ["Done now."],
      reset: true,
    });
  });

  it("closes with the unsaid tail, using the final text only when it extends what streamed", () => {
    const segmenter = createMinkSpeechSegmenter();
    segmenter.push("First sentence. Second");
    expect(segmenter.close("First sentence. Second sentence.")).toEqual([
      "Second sentence.",
    ]);
    expect(segmenter.closed).toBe(true);
    expect(segmenter.push("Anything at all. More")).toEqual({
      pieces: [],
      reset: false,
    });
    expect(segmenter.close()).toEqual([]);

    const diverging = createMinkSpeechSegmenter();
    diverging.push("First sentence. Second half");
    expect(diverging.close("Completely different text.")).toEqual([
      "Second half.",
    ]);
    expect(createMinkSpeechSegmenter().close()).toEqual([]);
  });

  it("speaks markdown as words and bounds the first piece short", () => {
    const segmenter = createMinkSpeechSegmenter();
    const first =
      "You have **twelve** orders today, which is three more than yesterday and the best Tuesday this store has had since the festive week in April.";
    const second =
      "Most of them came from the website in the evening, and two are still waiting to be packed at the Delhi warehouse before the courier arrives.";
    expect(segmenter.push(`${first} ${second} Next`).pieces).toEqual([
      first.replace(/\*\*/g, ""),
      second,
    ]);
  });

  it("stops handing out pieces past the turn's cap", () => {
    const segmenter = createMinkSpeechSegmenter({ maxChars: 30 });
    expect(
      segmenter.push(
        "One sentence here. Two sentence here. Three sentence here. Four",
      ),
    ).toEqual({
      pieces: ["One sentence here. Two sentence here. Three sentence here."],
      reset: false,
    });
    expect(segmenter.close("… Four sentence here.")).toEqual([]);
  });
});

describe("isEchoTranscript", () => {
  it("recognises Mink's own words coming back and leaves real replies alone", () => {
    const said =
      "You have twelve orders today. Three of them still need packing.";
    expect(isEchoTranscript("three of them still need packing", said)).toBe(
      true,
    );
    expect(isEchoTranscript("which three need packing first", said)).toBe(
      false,
    );
    expect(isEchoTranscript("yes", said)).toBe(false);
    expect(isEchoTranscript("ok thanks", "")).toBe(false);
  });
});
