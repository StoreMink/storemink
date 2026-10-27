// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatMinkClock,
  MinkWaveform,
  minkWaveformHeight,
} from "./mink-waveform";

describe("minkWaveformHeight", () => {
  it("spreads ordinary speech across the bar and caps a shout", () => {
    expect(minkWaveformHeight(0)).toBe(0);
    expect(minkWaveformHeight(-1)).toBe(0);
    expect(minkWaveformHeight(Number.NaN)).toBe(0);
    expect(minkWaveformHeight(0.05)).toBeCloseTo(0.5);
    expect(minkWaveformHeight(0.2)).toBe(1);
    expect(minkWaveformHeight(0.9)).toBe(1);
  });
});

describe("formatMinkClock", () => {
  it("reads like a recorder clock", () => {
    expect(formatMinkClock(0)).toBe("0:00");
    expect(formatMinkClock(7.9)).toBe("0:07");
    expect(formatMinkClock(65)).toBe("1:05");
    expect(formatMinkClock(Number.NaN)).toBe("0:00");
  });
});

describe("MinkWaveform", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const lastBar = () => {
    const bars = screen.getByTestId("mink-waveform").children;
    return bars[bars.length - 1] as HTMLElement;
  };

  it("draws the newest level on the right while live", () => {
    const levelRef = { current: 0.2 };
    render(<MinkWaveform levelRef={levelRef} live />);
    expect(lastBar().style.transform).toBe("scaleY(0.12)");
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(lastBar().style.transform).toBe("scaleY(1)");
  });

  it("rests flat and stops sampling when not live", () => {
    const levelRef = { current: 0.2 };
    const view = render(<MinkWaveform levelRef={levelRef} live />);
    act(() => {
      vi.advanceTimersByTime(80);
    });
    view.rerender(<MinkWaveform levelRef={levelRef} live={false} />);
    expect(lastBar().style.transform).toBe("scaleY(0.12)");
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(lastBar().style.transform).toBe("scaleY(0.12)");
  });
});
