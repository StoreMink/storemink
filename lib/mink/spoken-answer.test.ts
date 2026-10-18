import { describe, expect, it } from "vitest";
import { createSpokenAnswerSplitter, splitSpokenAnswer } from "./spoken-answer";

const REPLY =
  "<spoken>You have twelve orders today, three more than yesterday.</spoken>\n\n**12 orders** today, up from 9.";

function join(
  parts: ReturnType<ReturnType<typeof createSpokenAnswerSplitter>["push"]>,
) {
  const out = { spoken: "", written: "", ends: 0 };
  for (const part of parts) {
    if (part.kind === "spoken") out.spoken += part.text;
    else if (part.kind === "written") out.written += part.text;
    else out.ends += 1;
  }
  return out;
}

describe("createSpokenAnswerSplitter", () => {
  it("★ reads the block whichever byte a fragment boundary falls on", () => {
    for (let cut = 1; cut < REPLY.length; cut += 1) {
      const splitter = createSpokenAnswerSplitter();
      const parts = [
        ...splitter.push(REPLY.slice(0, cut)),
        ...splitter.push(REPLY.slice(cut)),
        ...splitter.finish(),
      ];
      const { spoken, written, ends } = join(parts);
      expect(spoken, `cut at ${cut}`).toBe(
        "You have twelve orders today, three more than yesterday.",
      );
      expect(written, `cut at ${cut}`).toBe(
        "\n\n**12 orders** today, up from 9.",
      );
      expect(ends, `cut at ${cut}`).toBe(1);
    }
  });

  it("keeps document order inside one fragment and ends the block once", () => {
    const splitter = createSpokenAnswerSplitter();
    expect(splitter.push("Hi. <spoken>Said.</spoken> Shown.")).toEqual([
      { kind: "written", text: "Hi. " },
      { kind: "spoken", text: "Said." },
      { kind: "spoken_end" },
      { kind: "written", text: " Shown." },
    ]);
    // A second block, or a close with nothing open, is dropped on both sides.
    expect(splitter.push(" <spoken>Again</spoken> more</spoken>")).toEqual([
      { kind: "written", text: " Again more" },
    ]);
  });

  it("holds back only a tag prefix, so plain text streams unchanged", () => {
    const splitter = createSpokenAnswerSplitter();
    expect(splitter.push("Sales are 3 < 5 and ")).toEqual([
      { kind: "written", text: "Sales are 3 < 5 and " },
    ]);
    expect(splitter.push("a <")).toEqual([{ kind: "written", text: "a " }]);
    expect(splitter.push("b")).toEqual([{ kind: "written", text: "<b" }]);
    expect(splitter.finish()).toEqual([]);
  });

  it("speaks an unclosed block to the end", () => {
    const splitter = createSpokenAnswerSplitter();
    expect(splitter.push("<spoken>Half a thought")).toEqual([
      { kind: "spoken", text: "Half a thought" },
    ]);
    expect(splitter.push(" and the rest.")).toEqual([
      { kind: "spoken", text: " and the rest." },
    ]);
    expect(splitter.finish()).toEqual([]);
  });

  it("starts over on reset, so a withdrawn block can open again", () => {
    const splitter = createSpokenAnswerSplitter();
    splitter.push("<spoken>Let me check.</spoken>");
    splitter.reset();
    expect(splitter.push("<spoken>Done.</spoken> Here.")).toEqual([
      { kind: "spoken", text: "Done." },
      { kind: "spoken_end" },
      { kind: "written", text: " Here." },
    ]);
  });
});

describe("splitSpokenAnswer", () => {
  it("returns the written answer and the spoken block separately", () => {
    expect(splitSpokenAnswer(REPLY)).toEqual({
      written: "**12 orders** today, up from 9.",
      spoken: "You have twelve orders today, three more than yesterday.",
    });
  });

  it("matches what the streamed parts added up to", () => {
    const splitter = createSpokenAnswerSplitter();
    const streamed = join([
      ...REPLY.split("").flatMap((char) => splitter.push(char)),
      ...splitter.finish(),
    ]);
    const whole = splitSpokenAnswer(REPLY);
    expect(streamed.spoken.trim()).toBe(whole.spoken);
    expect(streamed.written.trim()).toBe(whole.written);
  });

  it("leaves a written-only reply alone and falls back when the block never closes", () => {
    expect(splitSpokenAnswer("Just **text** here.")).toEqual({
      written: "Just **text** here.",
      spoken: null,
    });
    expect(splitSpokenAnswer("<spoken>Only said, never closed")).toEqual({
      written: "Only said, never closed",
      spoken: "Only said, never closed",
    });
    expect(splitSpokenAnswer("Note. <spoken>Said but unclosed")).toEqual({
      written: "Note.\n\nSaid but unclosed",
      spoken: "Said but unclosed",
    });
    expect(splitSpokenAnswer("")).toEqual({ written: "", spoken: null });
  });
});
