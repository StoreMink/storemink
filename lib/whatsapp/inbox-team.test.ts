import { beforeEach, describe, expect, it } from "vitest";
import {
  makeDbMock,
  sqlParamValues,
  sqlText,
} from "@/app/actions/_test-helpers";

import {
  addNote,
  assignConversation,
  deleteLabel,
  saveCannedReply,
  saveLabel,
  setConversationLabels,
} from "./inbox-team";

const STORE = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const L1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const L2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let mock: ReturnType<typeof makeDbMock>;
const texts = () => mock.calls.execute.map(sqlText);

beforeEach(() => {
  mock = makeDbMock({});
});

describe("assignConversation", () => {
  it("★ checks the person is on THIS store before writing, and reports whether it changed hands", async () => {
    mock = makeDbMock({
      executeQueue: [[{ id: "admin-2" }], [{ previous: "admin-1" }]],
    });
    const r = await assignConversation(mock.db, {
      storeId: STORE,
      conversationId: CONV,
      adminId: "admin-2",
    });
    expect(r).toEqual({
      ok: true,
      value: { changed: true, previous: "admin-1" },
    });
    expect(texts()[0]).toMatch(/select id from public\.admins/);
    expect(texts()[0]).toContain("coalesce(is_suspended, false) = false");
    expect(sqlParamValues(mock.calls.execute[0])).toEqual([STORE, "admin-2"]);
    // The row is locked while its previous assignee is read.
    expect(texts()[1]).toContain("for update");
    expect(sqlParamValues(mock.calls.execute[1])).toContain("admin-2");
  });

  it("a person not on the store is refused, with nothing written", async () => {
    mock = makeDbMock({ executeQueue: [[]] });
    const r = await assignConversation(mock.db, {
      storeId: STORE,
      conversationId: CONV,
      adminId: "stranger",
    });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    expect(mock.calls.execute).toHaveLength(1);
  });

  it("unassigning checks nobody and reports no change when it was already nobody", async () => {
    mock = makeDbMock({ executeQueue: [[{ previous: null }]] });
    const r = await assignConversation(mock.db, {
      storeId: STORE,
      conversationId: CONV,
      adminId: null,
    });
    expect(r).toEqual({ ok: true, value: { changed: false, previous: null } });
    expect(mock.calls.execute).toHaveLength(1);
  });
});

describe("setConversationLabels", () => {
  it("★ keeps only the store's own labels, deletes the rest and inserts the set idempotently", async () => {
    mock = makeDbMock({
      executeQueue: [[{ id: CONV }], [{ id: L1 }], [], []],
    });
    const r = await setConversationLabels(mock.db, {
      storeId: STORE,
      conversationId: CONV,
      labelIds: [L1, L2, L1],
    });
    expect(r).toEqual({ ok: true, value: { labelIds: [L1] } });
    const t = texts();
    expect(t[0]).toContain("for update");
    expect(t[1]).toMatch(/select id from public\.whatsapp_labels/);
    expect(t[2]).toMatch(/delete from public\.whatsapp_conversation_labels/);
    expect(t[2]).toContain("and label_id <> all(");
    expect(t[3]).toMatch(/insert into public\.whatsapp_conversation_labels/);
    expect(t[3]).toContain("on conflict do nothing");
  });

  it("an empty set clears every label with one delete and no insert", async () => {
    mock = makeDbMock({ executeQueue: [[{ id: CONV }], []] });
    const r = await setConversationLabels(mock.db, {
      storeId: STORE,
      conversationId: CONV,
      labelIds: [],
    });
    expect(r).toEqual({ ok: true, value: { labelIds: [] } });
    expect(mock.calls.execute).toHaveLength(2);
    expect(texts()[1]).not.toContain("<> all(");
  });

  it("a conversation on another store is not found", async () => {
    mock = makeDbMock({ executeQueue: [[]] });
    const r = await setConversationLabels(mock.db, {
      storeId: STORE,
      conversationId: CONV,
      labelIds: [L1],
    });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("saveLabel / deleteLabel", () => {
  it("★ a new label counts the store's labels under a lock and refuses the twenty-first", async () => {
    mock = makeDbMock({ executeQueue: [[], [{ n: 20 }]] });
    const r = await saveLabel(mock.db, {
      storeId: STORE,
      id: null,
      name: "VIP",
      color: "purple",
    });
    expect(r).toMatchObject({ ok: false, code: "limit" });
    expect(texts()[0]).toContain("pg_advisory_xact_lock");
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("inserts a valid new label at the end of the store's order", async () => {
    mock = makeDbMock({ executeQueue: [[], [{ n: 3 }], [{ id: L1 }]] });
    const r = await saveLabel(mock.db, {
      storeId: STORE,
      id: null,
      name: " VIP ",
      color: "neon",
    });
    expect(r).toEqual({ ok: true, value: { id: L1 } });
    expect(texts()[2]).toMatch(/insert into public\.whatsapp_labels/);
    expect(sqlParamValues(mock.calls.execute[2])).toEqual(
      expect.arrayContaining(["VIP", "grey"]),
    );
  });

  it("a rename touches only the store's own row, and an invalid name never reaches the database", async () => {
    mock = makeDbMock({ executeQueue: [[{ id: L1 }]] });
    const r = await saveLabel(mock.db, {
      storeId: STORE,
      id: L1,
      name: "Wholesale",
      color: "blue",
    });
    expect(r).toEqual({ ok: true, value: { id: L1 } });
    expect(texts()[0]).toMatch(/update public\.whatsapp_labels/);
    expect(sqlParamValues(mock.calls.execute[0])).toEqual(
      expect.arrayContaining([L1, STORE]),
    );
    const bad = await saveLabel(mock.db, {
      storeId: STORE,
      id: null,
      name: "",
      color: "red",
    });
    expect(bad).toMatchObject({ ok: false, code: "invalid" });
    expect(mock.calls.execute).toHaveLength(1);
    mock = makeDbMock({ executeQueue: [[]] });
    expect(
      await deleteLabel(mock.db, { storeId: STORE, id: L2 }),
    ).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });
});

describe("addNote", () => {
  it("writes the note through the conversation's own store, bounded", async () => {
    mock = makeDbMock({ executeQueue: [[{ id: "n1" }]] });
    const r = await addNote(mock.db, {
      storeId: STORE,
      conversationId: CONV,
      adminId: "admin-1",
      body: "  Bulk buyer\r\n",
    });
    expect(r).toEqual({ ok: true, value: { id: "n1" } });
    expect(texts()[0]).toMatch(
      /insert into public\.whatsapp_conversation_notes/,
    );
    expect(texts()[0]).toContain("from public.whatsapp_conversations c");
    expect(sqlParamValues(mock.calls.execute[0])).toContain("Bulk buyer");
    expect(
      await addNote(mock.db, {
        storeId: STORE,
        conversationId: CONV,
        adminId: "admin-1",
        body: "x".repeat(2001),
      }),
    ).toMatchObject({ ok: false, code: "invalid" });
  });
});

describe("saveCannedReply", () => {
  it("★ refuses a shortcut another reply already uses, before counting or writing", async () => {
    mock = makeDbMock({ executeQueue: [[], [{ id: "other" }]] });
    const r = await saveCannedReply(mock.db, {
      storeId: STORE,
      id: null,
      adminId: "admin-1",
      shortcut: "/Hours",
      title: "Hours",
      body: "10 to 7",
    });
    expect(r).toMatchObject({ ok: false, code: "invalid" });
    expect(r.ok ? "" : r.error).toContain('"/hours"');
    expect(mock.calls.execute).toHaveLength(2);
  });

  it("the fifty-first is refused; a valid new one is inserted with its author", async () => {
    mock = makeDbMock({ executeQueue: [[], [], [{ n: 50 }]] });
    expect(
      await saveCannedReply(mock.db, {
        storeId: STORE,
        id: null,
        adminId: "admin-1",
        shortcut: "ship",
        title: "Shipping",
        body: "2 days",
      }),
    ).toMatchObject({ ok: false, code: "limit" });
    mock = makeDbMock({ executeQueue: [[], [], [{ n: 4 }], [{ id: "r1" }]] });
    const r = await saveCannedReply(mock.db, {
      storeId: STORE,
      id: null,
      adminId: "admin-1",
      shortcut: "ship",
      title: "Shipping",
      body: "2 days",
    });
    expect(r).toEqual({ ok: true, value: { id: "r1" } });
    expect(sqlParamValues(mock.calls.execute[3])).toEqual(
      expect.arrayContaining(["ship", "Shipping", "2 days", "admin-1"]),
    );
  });
});
