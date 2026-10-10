// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";

// reCAPTCHA's own rule, which jsdom cannot load: a second widget may not be
// rendered into an element that already holds one. The fake verifier records
// the element it was given so the test can check that rule is never broken.
const state = vi.hoisted(() => ({ used: new Set<Element>() }));
vi.mock("firebase/auth", () => ({
  RecaptchaVerifier: vi.fn(function (
    this: any,
    _auth: unknown,
    element: HTMLElement,
    params: unknown,
  ) {
    if (state.used.has(element)) {
      throw new Error("reCAPTCHA has already been rendered in this element");
    }
    state.used.add(element);
    this.element = element;
    this.params = params;
    this.clear = vi.fn(() => {
      // Like the SDK for an INVISIBLE widget: the element keeps its widget.
    });
  }),
}));

import { freshInvisibleVerifier } from "./recaptcha";

const auth = {} as never;

beforeEach(() => {
  state.used.clear();
});

describe("freshInvisibleVerifier", () => {
  it("★ a retry gets a new element, so reCAPTCHA can render again", () => {
    const host = document.createElement("div");
    const first = freshInvisibleVerifier(auth, host, null) as any;
    const second = freshInvisibleVerifier(auth, host, first) as any;
    const third = freshInvisibleVerifier(auth, host, second) as any;

    expect(new Set([first.element, second.element, third.element]).size).toBe(
      3,
    );
    expect(first.element).not.toBe(host);
    expect(first.clear).toHaveBeenCalledTimes(1);
    expect(second.clear).toHaveBeenCalledTimes(1);
  });

  it("leaves only the current widget's element in the host", () => {
    const host = document.createElement("div");
    const first = freshInvisibleVerifier(auth, host, null) as any;
    const second = freshInvisibleVerifier(auth, host, first) as any;
    expect(host.children.length).toBe(1);
    expect(host.firstElementChild).toBe(second.element);
    expect(second.params).toEqual({ size: "invisible" });
  });

  it("a verifier that was already cleared does not stop the next send", () => {
    const host = document.createElement("div");
    const first = freshInvisibleVerifier(auth, host, null) as any;
    first.clear.mockImplementation(() => {
      throw new Error("auth/internal-error");
    });
    expect(() => freshInvisibleVerifier(auth, host, first)).not.toThrow();
  });
});
