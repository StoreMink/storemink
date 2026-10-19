// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import type { MinkVoiceComposer } from "./chat-context";
import type { MinkPreparedSend } from "./mink-ai";
import {
  MinkMultimodalInput,
  shouldReadMinkImageAsStorefrontDesign,
  shouldUseMinkImageOnStorefront,
} from "./mink-multimodal-input";

const recording = vi.hoisted(() => ({
  start: vi.fn(),
  done: null as null | ((file: File | null) => void),
  signal: null as AbortSignal | null,
}));
vi.mock("@/lib/mink/voice-recorder", () => ({
  startMinkRecording: recording.start,
}));
const media = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn() }));
vi.mock("@/app/actions/media-actions", () => ({
  uploadMediaAsset: media.upload,
  deleteMediaAsset: media.remove,
}));
// The composer reads the voice loop only for its toggle; one mutable value
// the voice tests move and every other test ignores.
const voice = vi.hoisted(() => {
  const value = {
    enabled: false,
    state: "idle",
    mic: "closed",
    support: { ok: true } as { ok: true } | { ok: false; reason: string },
    levelRef: { current: 0 },
    heard: null as string | null,
    said: null as string | null,
    notice: null as string | null,
    toggle: vi.fn(),
    noteSend: vi.fn(),
    registerComposer: vi.fn<(composer: MinkVoiceComposer) => () => void>(
      () => () => {},
    ),
  };
  return { value, useMinkVoice: vi.fn(() => value) };
});
vi.mock("./chat-context", () => ({
  useChat: vi.fn(),
  useMinkVoice: voice.useMinkVoice,
}));

const fetchMock = vi.fn();
const SAVED_URL =
  "https://storage.googleapis.com/b/stores/s1/media/echos_1.webp";

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ text: "Visible product and storefront details" }),
  });
  media.upload.mockReset();
  media.remove.mockReset();
  media.upload.mockResolvedValue({
    asset: { id: "asset-1", url: SAVED_URL, filename: "echos.png" },
  });
  media.remove.mockResolvedValue({ success: true });
  recording.start.mockReset();
  recording.done = null;
  recording.signal = null;
  recording.start.mockImplementation((signal, done, progress) => {
    recording.signal = signal;
    recording.done = done;
    progress();
    return Promise.resolve(vi.fn());
  });
  URL.createObjectURL = vi.fn(() => "blob:local");
  URL.revokeObjectURL = vi.fn();
  voice.value.enabled = false;
  voice.value.support = { ok: true };
  voice.value.toggle.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function LiveComposer({
  initial = "",
  canSaveMedia = false,
  onSubmit,
  onSubmitPrepared,
}: {
  initial?: string;
  canSaveMedia?: boolean;
  onSubmit?: (message: string) => void;
  onSubmitPrepared?: (prepared: MinkPreparedSend) => boolean;
  /** Changing it re-renders the composer, which is how a mocked reply lands. */
  tick?: number;
}) {
  const [value, setValue] = useState(initial);
  return (
    <MinkMultimodalInput
      message={value}
      onAdd={setValue}
      disabled={false}
      canSaveMedia={canSaveMedia}
      onSubmit={onSubmit}
      onSubmitPrepared={
        onSubmitPrepared &&
        ((prepared) => {
          // As the chat does: a message it takes leaves the box.
          const taken = onSubmitPrepared(prepared);
          if (taken) setValue("");
          return taken;
        })
      }
    >
      {({ attach, attachment, voice, submit, recorder }) => (
        <div>
          {attachment}
          {attach}
          <textarea
            aria-label="Message"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {recorder}
          {voice}
          <button type="button" onClick={() => void submit()}>
            Send message
          </button>
        </div>
      )}
    </MinkMultimodalInput>
  );
}

async function stageImage() {
  const file = new File(["source"], "echos.png", { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("source").buffer,
  });
  fireEvent.change(screen.getByLabelText("Choose image or document"), {
    target: { files: [file] },
  });
  return screen.findByRole("button", { name: "View echos.png" });
}

describe("ChatGPT-style Mink attachments", () => {
  it("shows only plus and mic controls at rest", () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    expect(
      screen.getByRole("button", { name: "Add image or document" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Dictate message" }),
    ).toBeEnabled();
    expect(screen.queryByText(/Process for review/i)).toBeNull();
    expect(screen.queryByText(/I approve sending/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stages an image as a square preview and opens a viewer", async () => {
    render(<LiveComposer initial="What is in this image?" />);
    const preview = await stageImage();
    expect(preview).toHaveClass("h-16", "w-16");
    expect(preview.querySelector("img")).toHaveAttribute("src", "blob:local");
    fireEvent.click(preview);
    expect(
      screen.getByRole("dialog", { name: "Attachment preview: echos.png" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Close attachment preview" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("automatically processes and sends a generic image without an approval box", async () => {
    const submit = vi.fn();
    render(<LiveComposer initial="What is written here?" onSubmit={submit} />);
    await stageImage();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(media.upload).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith(
      expect.stringContaining("Visible product and storefront details"),
    );
    expect(submit).toHaveBeenCalledWith(
      expect.stringContaining("untrusted source text"),
    );
  });

  it("uploads a permitted image immediately and includes its exact URL on Send", async () => {
    const submit = vi.fn();
    render(
      <LiveComposer
        initial="Create a new product from this image"
        canSaveMedia
        onSubmit={submit}
      />,
    );
    await stageImage();
    await waitFor(() => expect(media.upload).toHaveBeenCalledOnce());
    // ★ Labelled as a chat attachment, so the Media Library does not list it;
    //   the row is still written, which is what lets Mink use the image.
    const form = media.upload.mock.calls[0][0] as FormData;
    expect(form.get("purpose")).toBe("mink_attachment");
    expect(form.get("file")).toBeInstanceOf(File);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(media.upload).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = submit.mock.calls[0][0] as string;
    expect(sent).toContain(SAVED_URL);
    expect(sent).toContain("Visible product and storefront details");
  });

  it("reads a storefront style screenshot through validated design mode", async () => {
    const submit = vi.fn();
    render(
      <LiveComposer
        initial="Make my storefront design match this screenshot's colours and fonts"
        canSaveMedia
        onSubmit={submit}
      />,
    );
    await stageImage();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(request).toMatchObject({ mode: "design", confirmed: true });
  });

  it("sends local text files automatically without a provider call", async () => {
    const submit = vi.fn();
    render(<LiveComposer initial="Summarise this" onSubmit={submit} />);
    const file = new File(["Stock notes"], "stock.txt");
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("Stock notes").buffer,
    });
    fireEvent.change(screen.getByLabelText("Choose image or document"), {
      target: { files: [file] },
    });
    await screen.findByRole("button", { name: "View stock.txt" });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit).toHaveBeenCalledWith(expect.stringContaining("Stock notes"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires Media permission when the exact image must become a product or storefront asset", async () => {
    const submit = vi.fn();
    render(
      <LiveComposer
        initial="Create a new product using this image"
        onSubmit={submit}
      />,
    );
    await stageImage();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /permission to add Media Library images/i,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("removes a staged attachment and revokes its object URL", async () => {
    render(<LiveComposer initial="Use this" />);
    await stageImage();
    fireEvent.click(screen.getByRole("button", { name: "Remove echos.png" }));
    expect(screen.queryByRole("button", { name: "View echos.png" })).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local");
  });

  it("cleans up an immediately uploaded image when the composer is abandoned", async () => {
    const view = render(
      <LiveComposer initial="Use this" canSaveMedia onSubmit={vi.fn()} />,
    );
    await stageImage();
    await waitFor(() => expect(media.upload).toHaveBeenCalledOnce());
    view.unmount();
    await waitFor(() => expect(media.remove).toHaveBeenCalledWith("asset-1"));
  });

  it("accepts five attachments in one selection", async () => {
    render(<LiveComposer initial="Compare these" />);
    const files = Array.from(
      { length: 5 },
      (_, index) => new File([`note ${index}`], `note-${index}.txt`),
    );
    for (const [index, file] of files.entries()) {
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new TextEncoder().encode(`note ${index}`).buffer,
      });
    }
    fireEvent.change(screen.getByLabelText("Choose image or document"), {
      target: { files },
    });
    expect(
      await screen.findByRole("button", { name: "View note-4.txt" }),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^View note-/ })).toHaveLength(
      5,
    );
    expect(
      screen.getByRole("button", { name: "Add image or document" }),
    ).toBeDisabled();
  });

  // ★★ A FAILED SEND MUST NOT RE-READ WHAT ALREADY SUCCEEDED. submit() rebuilds
  // the message from raw text every time, so without a cached reading a
  // five-file send that died on the last file re-extracted the first four —
  // five more provider calls and five more slots of the per-minute input
  // budget, so the retry hit the rate limit instead of the real fault.
  it("re-reads only the attachment that failed", async () => {
    const submit = vi.fn();
    render(<LiveComposer initial="Compare these" onSubmit={submit} />);
    const files = ["a.pdf", "b.pdf"].map((name) => {
      const file = new File(["x"], name, { type: "application/pdf" });
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new TextEncoder().encode("x").buffer,
      });
      return file;
    });
    fireEvent.change(screen.getByLabelText("Choose image or document"), {
      target: { files },
    });
    expect(
      await screen.findByRole("button", { name: "View b.pdf" }),
    ).toBeVisible();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: "First reading" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Busy" }),
      });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("alert");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "Second reading" }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    // One more call, not two: a.pdf's reading was kept.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(submit.mock.calls[0][0]).toContain("First reading");
    expect(submit.mock.calls[0][0]).toContain("Second reading");
  });

  // ★★ FIVE 3,000-CHARACTER NOTES CANNOT FIT 12,000 CHARACTERS, and the Help
  // guide offers exactly that combination. It used to be refused at Send, after
  // staging, with "shorten the text" — advice about a file the composer cannot
  // edit.
  it("refuses local text that cannot fit before staging it", async () => {
    render(<LiveComposer initial="Summarise these" />);
    const files = Array.from({ length: 5 }, (_, index) => {
      const body = "n".repeat(2900);
      const file = new File([body], `note-${index}.md`);
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new TextEncoder().encode(body).buffer,
      });
      return file;
    });
    fireEvent.change(screen.getByLabelText("Choose image or document"), {
      target: { files },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /do not fit in 12,000 characters/i,
    );
    expect(screen.queryByRole("button", { name: "View note-0.md" })).toBeNull();
  });

  // ★★ A DISCARDED UPLOAD MUST OUTLIVE THE PAGE. The unmount cleanup calls a
  // Server Action, which the browser cancels on unload, so a selected-then-
  // abandoned image stayed in the merchant's Media Library.
  it("beacons a staged upload away when the page is discarded", async () => {
    const beacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    render(<LiveComposer initial="Use this" canSaveMedia onSubmit={vi.fn()} />);
    await stageImage();
    await waitFor(() => expect(media.upload).toHaveBeenCalledOnce());

    // bfcache: the page comes back with the preview still on screen.
    fireEvent(
      window,
      Object.assign(new Event("pagehide"), { persisted: true }),
    );
    expect(beacon).not.toHaveBeenCalled();

    fireEvent(
      window,
      Object.assign(new Event("pagehide"), { persisted: false }),
    );
    expect(beacon).toHaveBeenCalledWith(
      "/api/mink/media/discard",
      expect.any(Blob),
    );
  });

  it("dismisses attachment errors after a few seconds", async () => {
    vi.useFakeTimers();
    try {
      render(<LiveComposer initial="Read this" />);
      fireEvent.change(screen.getByLabelText("Choose image or document"), {
        target: { files: [new File(["x"], "attack.html")] },
      });
      await act(async () => Promise.resolve());
      expect(screen.getByRole("alert")).toBeVisible();
      act(() => vi.advanceTimersByTime(5001));
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported, audio and oversized text attachments", async () => {
    render(<LiveComposer initial="Read this" />);
    const input = screen.getByLabelText("Choose image or document");
    fireEvent.change(input, {
      target: { files: [new File(["x"], "attack.html")] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/PNG, JPEG, WebP/);
    fireEvent.change(input, {
      target: { files: [new File(["x"], "note.wav")] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/microphone button/i);
    fireEvent.change(input, {
      target: { files: [new File(["x".repeat(8193)], "large.txt")] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/8 KiB/i);
  });
});

describe("Mink attachment intent", () => {
  it("recognises product creation and explicit storefront placement", () => {
    expect(
      shouldUseMinkImageOnStorefront(
        "Create the homepage carousel and use this photo",
      ),
    ).toBe(true);
    expect(shouldUseMinkImageOnStorefront("Create a new product")).toBe(true);
    expect(shouldUseMinkImageOnStorefront("What is written here?")).toBe(false);
  });

  it("uses design mode only for storefront style requests", () => {
    expect(
      shouldReadMinkImageAsStorefrontDesign(
        "Make my storefront match these colours and fonts",
      ),
    ).toBe(true);
    expect(
      shouldReadMinkImageAsStorefrontDesign(
        "Remove this heading from my storefront",
      ),
    ).toBe(false);
  });

  it("★★ catches the sentence people actually type", () => {
    // Every one of these missed the validated reader and fell back to a prose
    // paraphrase of the reference, silently, including the exact phrase this
    // whole path was built for.
    for (const message of [
      "Make my shop look like this",
      "I like this site, can you make my store similar",
      "Recreate this layout on my home page",
      "Use this as inspiration for my brand design",
    ]) {
      expect(shouldReadMinkImageAsStorefrontDesign(message)).toBe(true);
    }
  });

  it("★ still needs an appearance word, not just a destination", () => {
    // A placement request names the shop and says nothing about how it looks,
    // so the general reader — which can quote what is in the picture — stays
    // the right one.
    for (const message of [
      "Add this photo to my shop page",
      "What does this say?",
      "Create a product from this image",
    ]) {
      expect(shouldReadMinkImageAsStorefrontDesign(message)).toBe(false);
    }
  });
});

describe("★★ a spoken turn takes what is staged in the hidden composer", () => {
  /** What the composer registered with voice chat when it mounted. */
  const registered = () => voice.value.registerComposer.mock.calls.at(-1)?.[0];

  it("hands back nothing when nothing is staged, so the transcript goes alone", () => {
    render(<LiveComposer initial="" />);
    expect(
      registered()?.(
        "Sales?",
        vi.fn(() => true),
      ),
    ).toBeNull();
  });

  it("sends the draft, the words and the staged image together, and keeps the upload", async () => {
    const submit = vi.fn();
    const view = render(
      <LiveComposer
        initial="Create a new product from this image"
        canSaveMedia
        onSubmit={submit}
      />,
    );
    await stageImage();
    await waitFor(() => expect(media.upload).toHaveBeenCalledOnce());
    const deliver = vi.fn<(message: string) => boolean>(() => true);
    let taken: boolean | null | undefined;
    await act(async () => {
      taken = await registered()?.("call it Almond Shake", deliver);
    });
    expect(taken).toBe(true);
    // Voice chat delivers it as a spoken turn; the typed send is not used.
    expect(submit).not.toHaveBeenCalled();
    const sent = deliver.mock.calls[0][0] as string;
    expect(
      sent.startsWith(
        "Create a new product from this image call it Almond Shake",
      ),
    ).toBe(true);
    expect(sent).toContain(SAVED_URL);
    expect(screen.queryByRole("button", { name: "View echos.png" })).toBeNull();
    // The composer remounts once the new conversation has its id: the image
    // went with the message, so its upload must survive that.
    view.unmount();
    expect(media.remove).not.toHaveBeenCalled();
  });

  it("leaves the words in the box when the turn cannot go", async () => {
    render(<LiveComposer initial="Draft" />);
    let taken: boolean | null | undefined;
    await act(async () => {
      taken = await registered()?.(
        "and more",
        vi.fn(() => false),
      );
    });
    expect(taken).toBe(false);
    expect(screen.getByLabelText("Message")).toHaveValue("Draft and more");
  });
});

describe("Mink dictation", () => {
  it("inserts one final transcript and waits for Send", async () => {
    const submit = vi.fn();
    render(<LiveComposer initial="Please" onSubmit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    expect(await screen.findByText(/Listening/i)).toBeVisible();
    act(() =>
      recording.done?.(
        new File(["wav"], "voice-note.wav", { type: "audio/wav" }),
      ),
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByLabelText("Message")).toHaveValue(
        "Please Visible product and storefront details",
      ),
    );
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(submit).toHaveBeenCalledOnce();
  });

  it("★ says no words were recognised, not that transcription failed, when the clip held none", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: "", languageCode: null }),
    });
    render(<LiveComposer initial="Please" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    expect(await screen.findByText(/Listening/i)).toBeVisible();
    act(() =>
      recording.done?.(
        new File(["wav"], "voice-note.wav", { type: "audio/wav" }),
      ),
    );
    expect(
      await screen.findByText(
        "No speech was recognised. Try again or type your message.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("Please");
  });

  it("cancels dictation without changing the message", async () => {
    render(<LiveComposer initial="Existing" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    await waitFor(() => expect(recording.signal).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Cancel dictation" }));
    expect(recording.signal?.aborted).toBe(true);
    expect(screen.getByLabelText("Message")).toHaveValue("Existing");
  });
});

describe("★★ dictation lives inside the composer, ChatGPT-style", () => {
  it("swaps the old status bar for a waveform, a clock, Cancel and Done", async () => {
    render(<LiveComposer initial="" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    const recorder = await screen.findByTestId("mink-recorder");
    expect(screen.getByTestId("mink-waveform")).toBeInTheDocument();
    expect(recorder).toHaveTextContent("0:00");
    expect(
      screen.getByRole("button", { name: "Cancel dictation" }),
    ).toBeEnabled();
    const done = screen.getByRole("button", { name: "Finish dictation" });
    await waitFor(() => expect(done).toBeEnabled());
    await waitFor(() => expect(done).toHaveFocus());
    // The full-width bar and its instruction are gone.
    expect(screen.queryByText(/pause when you are finished/i)).toBeNull();
  });

  it("keeps listening through a pause and finishes on Done", async () => {
    const stop = vi.fn(() =>
      recording.done?.(
        new File(["wav"], "voice-note.wav", { type: "audio/wav" }),
      ),
    );
    recording.start.mockImplementation((signal, done, progress) => {
      recording.signal = signal;
      recording.done = done;
      progress(4);
      return Promise.resolve(stop);
    });
    render(<LiveComposer initial="" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    await waitFor(() => expect(recording.start).toHaveBeenCalledOnce());
    expect(recording.start.mock.calls[0][3]).toMatchObject({
      endOnSilence: false,
    });
    expect(await screen.findByTestId("mink-recorder")).toHaveTextContent(
      "0:04",
    );
    const done = screen.getByRole("button", { name: "Finish dictation" });
    await waitFor(() => expect(done).toBeEnabled());
    fireEvent.click(done);
    expect(stop).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(screen.getByLabelText("Message")).toHaveValue(
        "Visible product and storefront details",
      ),
    );
    expect(screen.queryByTestId("mink-recorder")).toBeNull();
  });

  it("shows Transcribing… while the recording is converted", async () => {
    let answer!: (value: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    render(<LiveComposer initial="" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    await waitFor(() => expect(recording.done).not.toBeNull());
    act(() =>
      recording.done?.(
        new File(["wav"], "voice-note.wav", { type: "audio/wav" }),
      ),
    );
    expect(await screen.findByText("Transcribing…")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Finish dictation" }),
    ).toBeDisabled();
    await act(async () =>
      answer({ ok: true, json: async () => ({ text: "Hello" }) }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Message")).toHaveValue("Hello"),
    );
  });
});

describe("Mink voice chat", () => {
  it("renders the toggle disabled with the reason when the browser cannot run it", () => {
    voice.value.support = {
      ok: false,
      reason: "Voice chat needs a browser that can read answers aloud.",
    };
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    const toggle = screen.getByRole("button", { name: "Talk with Mink" });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute(
      "title",
      "Voice chat needs a browser that can read answers aloud.",
    );
    expect(toggle).toHaveAttribute("aria-pressed", "false");
  });

  it("★ the sound-wave button hands over to the shared loop, which owns the microphone", () => {
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Talk with Mink" }));
    expect(voice.value.toggle).toHaveBeenCalledOnce();
    // The composer opens no microphone of its own for voice chat.
    expect(recording.start).not.toHaveBeenCalled();
  });

  it("while voice chat is on, dictation is unavailable and the toggle reads pressed", () => {
    voice.value.enabled = true;
    render(<MinkMultimodalInput message="" onAdd={vi.fn()} disabled={false} />);
    const toggle = screen.getByRole("button", { name: "Talk with Mink" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Voice chat is listening for you" }),
    ).toBeDisabled();
    expect(screen.queryByTestId("mink-recorder")).toBeNull();
  });

  it("while dictating, voice chat cannot be started", async () => {
    render(<LiveComposer onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    await waitFor(() => expect(recording.start).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Talk with Mink" }),
    ).toBeDisabled();
  });

  it("keeps plain dictation unchanged while voice chat is off", async () => {
    const submit = vi.fn();
    render(<LiveComposer initial="Please" onSubmit={submit} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate message" }));
    expect(recording.start.mock.calls[0][3]).toMatchObject({
      endOnSilence: false,
    });
    act(() =>
      recording.done?.(
        new File(["wav"], "voice-note.wav", { type: "audio/wav" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Message")).toHaveValue(
        "Please Visible product and storefront details",
      ),
    );
    expect(submit).not.toHaveBeenCalled();
    expect(voice.value.toggle).not.toHaveBeenCalled();
  });
});

it("uploads an intact CSV privately without calling the visual reader", async () => {
  const submit = vi.fn();
  const text = 'Handle,Title,Base Price\nmilk,"Whole Milk",99\n';
  const file = new File([text], "products.csv", { type: "text/csv" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(text).buffer,
  });
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      file: {
        id: "11111111-1111-4111-8111-111111111111",
        filename: "products.csv",
      },
    }),
  });
  render(<LiveComposer initial="Import these products" onSubmit={submit} />);
  fireEvent.change(screen.getByLabelText("Choose image or document"), {
    target: { files: [file] },
  });
  await screen.findByText("products.csv");
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(submit).toHaveBeenCalledOnce());
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe("/api/mink/product-imports");
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).csv).toBe(text);
  expect(submit.mock.calls[0][0]).toContain("Private product CSV attachment");
  expect(submit.mock.calls[0][0]).not.toContain("Whole Milk");
  expect(media.upload).not.toHaveBeenCalled();
});

describe("★★ Enter hands a message with attachments to the chat at once", () => {
  function handOff() {
    const sent: MinkPreparedSend[] = [];
    const onSubmitPrepared = vi.fn((prepared: MinkPreparedSend) => {
      sent.push(prepared);
      return true;
    });
    return { sent, onSubmitPrepared };
  }

  it("clears the box and hands over the photo before anything is uploaded or read", async () => {
    let finishUpload!: () => void;
    media.upload.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve({
              asset: { id: "asset-1", url: SAVED_URL, filename: "echos.png" },
            });
        }),
    );
    const { sent, onSubmitPrepared } = handOff();
    render(
      <LiveComposer
        initial="Is this in stock?"
        canSaveMedia
        onSubmit={vi.fn()}
        onSubmitPrepared={onSubmitPrepared}
      />,
    );
    await stageImage();
    await waitFor(() => expect(media.upload).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSubmitPrepared).toHaveBeenCalledOnce();
    expect(sent[0]).toMatchObject({
      draft: "Is this in stock?",
      attachments: [
        { name: "echos.png", kind: "image", previewUrl: "blob:local" },
      ],
    });
    // Nothing is left in the box, and nothing has been read yet.
    expect(screen.queryByRole("button", { name: "View echos.png" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    const setStatus = vi.fn();
    const reading = sent[0]!.prepare({
      signal: new AbortController().signal,
      setStatus,
    });
    finishUpload();
    const finished = await reading;

    expect(finished.message).toContain("Is this in stock?");
    expect(finished.message).toContain(SAVED_URL);
    expect(finished.message).toContain(
      "Visible product and storefront details",
    );
    expect(finished.previews).toEqual({ [`url:${SAVED_URL}`]: "blob:local" });
    expect(setStatus).toHaveBeenCalledWith("Looking at your photo…");
    // ★ The upload begun when the photo was picked is the one used: no second.
    expect(media.upload).toHaveBeenCalledOnce();
    // ★ The chat shows that picture now, so it is not revoked here.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("puts the words and the photo back, with the reason, when reading fails, and keeps the upload", async () => {
    const { sent, onSubmitPrepared } = handOff();
    render(
      <LiveComposer
        initial="Is this in stock?"
        canSaveMedia
        onSubmit={vi.fn()}
        onSubmitPrepared={onSubmitPrepared}
      />,
    );
    await stageImage();
    await waitFor(() => expect(media.upload).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(screen.getByLabelText("Message")).toHaveValue("");

    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Busy" }),
    });
    await expect(
      sent[0]!.prepare({
        signal: new AbortController().signal,
        setStatus: vi.fn(),
      }),
    ).rejects.toThrow("Busy");

    let kept = false;
    act(() => {
      kept = sent[0]!.restore({ code: "attachment_failed", message: "Busy" });
    });

    expect(kept).toBe(true);
    expect(
      await screen.findByRole("button", { name: "View echos.png" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Busy");
    expect(screen.getByLabelText("Message")).toHaveValue("Is this in stock?");

    // Sending again reuses the saved copy: one upload in all.
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmitPrepared).toHaveBeenCalledTimes(2);
    await sent[1]!.prepare({
      signal: new AbortController().signal,
      setStatus: vi.fn(),
    });
    expect(media.upload).toHaveBeenCalledOnce();
  });

  it("sends a photo on its own, with no words", async () => {
    const { sent, onSubmitPrepared } = handOff();
    render(
      <LiveComposer onSubmit={vi.fn()} onSubmitPrepared={onSubmitPrepared} />,
    );
    await stageImage();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSubmitPrepared).toHaveBeenCalledOnce();
    expect(sent[0]?.draft).toBe("");
  });

  it("keeps everything in the box when the chat cannot take it", async () => {
    const onSubmitPrepared = vi.fn(() => false);
    render(
      <LiveComposer
        initial="Is this in stock?"
        onSubmit={vi.fn()}
        onSubmitPrepared={onSubmitPrepared}
      />,
    );
    await stageImage();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSubmitPrepared).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "View echos.png" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Message")).toHaveValue("Is this in stock?");
  });

  it("lets the files go but keeps the words when the box that sent them has closed", async () => {
    const { sent, onSubmitPrepared } = handOff();
    const onAdd = vi.fn();
    function ChatBox() {
      const [value, setValue] = useState("Is this in stock?");
      return (
        <MinkMultimodalInput
          message={value}
          onAdd={(next) => {
            onAdd(next);
            setValue(next);
          }}
          disabled={false}
          canSaveMedia
          onSubmit={vi.fn()}
          onSubmitPrepared={(prepared) => {
            const taken = onSubmitPrepared(prepared);
            if (taken) setValue("");
            return taken;
          }}
        >
          {({ attach, attachment, submit }) => (
            <div>
              {attachment}
              {attach}
              <button type="button" onClick={() => void submit()}>
                Send message
              </button>
            </div>
          )}
        </MinkMultimodalInput>
      );
    }
    const view = render(<ChatBox />);
    await stageImage();
    await waitFor(() => expect(media.upload).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await sent[0]!
      .prepare({ signal: new AbortController().signal, setStatus: vi.fn() })
      .catch(() => undefined);
    view.unmount();
    // ★ Handed over, so leaving did not delete the upload the message uses.
    expect(media.remove).not.toHaveBeenCalled();

    const kept = sent[0]!.restore({ code: "attachment_failed", message: "x" });

    expect(kept).toBe(false);
    expect(onAdd).toHaveBeenCalledWith("Is this in stock?");
    await waitFor(() => expect(media.remove).toHaveBeenCalledWith("asset-1"));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local");
  });
});
