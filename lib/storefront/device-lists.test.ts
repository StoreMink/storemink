// @vitest-environment jsdom
// The lists a shopper keeps on their own device: saved items and recently
// viewed (lib/storefront/device-lists.ts). Slugs only, bounded, and never a
// thrown error whatever the browser's storage does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_LIST_MAX,
  cleanSlug,
  clearDeviceList,
  noteViewed,
  parseDeviceList,
  readDeviceList,
  serverDeviceList,
  subscribeDeviceLists,
  toggleSaved,
} from "./device-lists";

beforeEach(() => {
  window.localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("what a list may hold", () => {
  it("only product slugs as the storefront writes them", () => {
    expect(cleanSlug("linen-shirt-2")).toBe("linen-shirt-2");
    for (const bad of [
      "Linen Shirt",
      "../admin",
      "a/b",
      "a--b",
      "-a",
      "",
      "a".repeat(121),
      "<script>",
      7,
      null,
      undefined,
    ])
      expect(cleanSlug(bad), String(bad)).toBeNull();
  });

  it("a stored value is read as slugs, without repeats, bounded, whatever was put there", () => {
    expect(parseDeviceList('["a","b","a","B!",7,null,"c"]', "recent")).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(parseDeviceList("not json", "recent")).toEqual([]);
    expect(parseDeviceList('{"a":1}', "recent")).toEqual([]);
    expect(parseDeviceList(null, "wishlist")).toEqual([]);
    const many = JSON.stringify(
      Array.from({ length: 500 }, (_, n) => `p-${n}`),
    );
    expect(parseDeviceList(many, "recent")).toHaveLength(
      DEVICE_LIST_MAX.recent,
    );
    expect(parseDeviceList(many, "wishlist")).toHaveLength(
      DEVICE_LIST_MAX.wishlist,
    );
  });
});

describe("★★ saved items", () => {
  it("a product is saved, then removed, newest first, and says which it now is", () => {
    expect(toggleSaved("bowl")).toBe(true);
    expect(toggleSaved("mug")).toBe(true);
    expect(readDeviceList("wishlist")).toEqual(["mug", "bowl"]);
    expect(toggleSaved("bowl")).toBe(false);
    expect(readDeviceList("wishlist")).toEqual(["mug"]);
    // Only slugs are kept: nothing about the product itself.
    expect(window.localStorage.getItem("sm:saved-products")).toBe('["mug"]');
    expect(toggleSaved("Not A Slug")).toBe(false);
    expect(readDeviceList("wishlist")).toEqual(["mug"]);
  });

  it("the list is bounded: the oldest falls off", () => {
    for (let n = 0; n < DEVICE_LIST_MAX.wishlist + 5; n += 1)
      toggleSaved(`p-${n}`);
    const list = readDeviceList("wishlist");
    expect(list).toHaveLength(DEVICE_LIST_MAX.wishlist);
    expect(list[0]).toBe(`p-${DEVICE_LIST_MAX.wishlist + 4}`);
    expect(list).not.toContain("p-0");
  });

  it("removing all empties it and leaves nothing in storage", () => {
    toggleSaved("bowl");
    clearDeviceList("wishlist");
    expect(readDeviceList("wishlist")).toEqual([]);
    expect(window.localStorage.getItem("sm:saved-products")).toBeNull();
  });
});

describe("recently viewed", () => {
  it("the product just looked at moves to the front, once", () => {
    noteViewed("bowl");
    noteViewed("mug");
    noteViewed("bowl");
    expect(readDeviceList("recent")).toEqual(["bowl", "mug"]);
    // The two lists are separate.
    expect(readDeviceList("wishlist")).toEqual([]);
  });

  it("looking at the same product again writes nothing", () => {
    noteViewed("bowl");
    const write = vi.spyOn(Storage.prototype, "setItem");
    noteViewed("bowl");
    expect(write).not.toHaveBeenCalled();
  });
});

describe("★★ a browser that will not keep it", () => {
  it("reads as empty and never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readDeviceList("wishlist")).toEqual([]);
    expect(() => noteViewed("bowl")).not.toThrow();
  });

  it("a save that storage refuses is not shown as saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    expect(toggleSaved("bowl")).toBe(false);
    expect(readDeviceList("wishlist")).toEqual([]);
  });
});

describe("for a component that watches a list", () => {
  it("gives the same array until the list changes, and tells listeners when it does", () => {
    toggleSaved("bowl");
    const first = readDeviceList("wishlist");
    expect(readDeviceList("wishlist")).toBe(first);
    const heard = vi.fn();
    const stop = subscribeDeviceLists(heard);
    toggleSaved("mug");
    expect(heard).toHaveBeenCalledTimes(1);
    expect(readDeviceList("wishlist")).not.toBe(first);
    // Another tab's change arrives as a storage event.
    window.dispatchEvent(new Event("storage"));
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    toggleSaved("plate");
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("the server renders nobody's list", () => {
    expect(serverDeviceList()).toEqual([]);
    expect(serverDeviceList()).toBe(serverDeviceList());
  });
});
