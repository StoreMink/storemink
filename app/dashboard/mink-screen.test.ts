// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { readMinkScreen } from "./mink-screen";

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
  window.history.replaceState(null, "", "/");
});

describe("readMinkScreen", () => {
  it("reads the title, headings, filters, rows, selection, dialog and labelled fields", () => {
    document.title = "Orders · StoreMink";
    window.history.replaceState(
      null,
      "",
      "/dashboard/orders?status=pending&prefill=mink",
    );
    document.body.innerHTML = `
      <main>
        <h1>Orders</h1>
        <div role="status">3 orders need attention</div>
        <table><tbody>
          <tr><td><input type="checkbox" checked /></td><td>ORD10011001</td><td>Priya</td><td>pending</td></tr>
          <tr><td><input type="checkbox" /></td><td>ORD10011002</td><td>Rahul</td><td>shipped</td></tr>
        </tbody></table>
        <form>
          <label for="q">Search</label><input id="q" value="ORD1001" />
          <label for="k">API key</label><input id="k" value="rzp_live_secret" />
          <label for="p">Password</label><input id="p" type="password" value="hunter2" />
          <label for="s">Status</label><select id="s"><option value="all">All</option><option value="pending" selected>Pending</option></select>
        </form>
        <div role="dialog"><h2>Refund order</h2></div>
      </main>
      <aside class="mink-chat-surface"><table><tbody><tr><td>chat row</td></tr></tbody></table><h1>Mink</h1></aside>
    `;
    expect(readMinkScreen()).toEqual({
      title: "Orders · StoreMink",
      headings: ["Orders"],
      query: { status: "pending" },
      dialog: "Refund order",
      notice: "3 orders need attention",
      rows: ["ORD10011001 · Priya · pending", "ORD10011002 · Rahul · shipped"],
      selectedCount: 1,
      fields: [
        { label: "Search", value: "ORD1001" },
        { label: "Status", value: "Pending" },
      ],
    });
  });

  it("returns null for an empty page", () => {
    document.body.innerHTML = "<main></main>";
    expect(readMinkScreen()).toBeNull();
  });
});
