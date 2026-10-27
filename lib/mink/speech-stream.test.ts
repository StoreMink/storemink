import { describe, expect, it } from "vitest";
import {
  createMinkSpeechSegmenter,
  isEchoTranscript,
  speechCutPoint,
} from "./speech-stream";
import {
  MINK_SPEECH_PIECE_MAX,
  speakableMinkText,
  splitSpeechChunks,
} from "./speech-text";

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

  it("★ forgets a withdrawn sentence, so the answer after it is still read", () => {
    const segmenter = createMinkSpeechSegmenter();
    expect(segmenter.push("Let me check your orders. Then").pieces).toEqual([
      "Let me check your orders.",
    ]);
    expect(segmenter.spoke).toBe(true);
    // A tool call withdrew it, and the final answer brought no block at all.
    segmenter.push("");
    expect(segmenter.spoke).toBe(false);
    expect(segmenter.close()).toEqual([]);
    expect(segmenter.spoke).toBe(false);
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

  it("★ closes on a final text whose whitespace differs from the stream's", () => {
    const segmenter = createMinkSpeechSegmenter();
    // The stream kept a line break; the final split collapsed it, and the
    // last sentence arrived only with the answer.
    expect(segmenter.push("Your sales today are up.\n\nOrders").pieces).toEqual(
      ["Your sales today are up."],
    );
    expect(
      segmenter.close("Your sales today are up. Orders are steady this week."),
    ).toEqual(["Orders are steady this week."]);
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

  it("★ judges a word or two only when every one of them is Mink's", () => {
    const said = "Your sales today are twelve thousand rupees.";
    // The fraction of a second a self-interruption captures.
    expect(isEchoTranscript("Sales are", said)).toBe(true);
    expect(isEchoTranscript("twelve", said)).toBe(true);
    expect(isEchoTranscript("stop", said)).toBe(false);
    expect(isEchoTranscript("sales yesterday", said)).toBe(false);
  });

  it("★ keeps Indic vowel signs inside a word, so a Hindi reply is not an echo", () => {
    // Each reply below was judged an echo when marks split the words into
    // single consonants ("स्टॉक" became "स", "ट", "क").
    const said =
      "आज की बिक्री बारह हज़ार रुपये है। तीन ऑर्डर अभी पैक होने बाकी हैं।";
    expect(isEchoTranscript("कौन से ऑर्डर बाकी हैं", said)).toBe(false);
    expect(
      isEchoTranscript(
        "स्टॉक बढ़ा दो",
        "बादाम शेक का स्टॉक कम है, सिर्फ़ पाँच बोतलें बची हैं।",
      ),
    ).toBe(false);
    expect(isEchoTranscript("तीन ऑर्डर अभी पैक होने बाकी हैं", said)).toBe(
      true,
    );
  });
});

describe("★ every piece fits one read-aloud request", () => {
  it("never hands the speech route more than the route accepts", () => {
    const words = (count: number) =>
      Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
    const answer = [
      // A sentence far longer than a piece, with no break in sight.
      `${words(260)}.`,
      "Short one.",
      // A run with no sentence end at all.
      words(400),
    ].join(" ");
    const segmenter = createMinkSpeechSegmenter({ maxChars: 100_000 });
    const pieces: string[] = [];
    for (let at = 1; at <= answer.length; at += 37)
      pieces.push(...segmenter.push(answer.slice(0, at)).pieces);
    pieces.push(...segmenter.close(answer));
    // And the written-answer fallback for a reply with no spoken block.
    pieces.push(...splitSpeechChunks(speakableMinkText(answer)));
    expect(pieces.length).toBeGreaterThan(4);
    for (const piece of pieces)
      expect(piece.length).toBeLessThanOrEqual(MINK_SPEECH_PIECE_MAX);
  });
});
