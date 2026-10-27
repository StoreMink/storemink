// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMinkScreenContext } from "@/lib/mink/page-context";
import { readMinkScreen } from "./mink-screen";

/** A 201-character delivery note: an address, then a request. */
const LONG_NOTE =
  "Flat 4B, Sunshine Apartments, 12 MG Road, Indiranagar. Please call first. I will be home after six in the evening on most weekdays, and the guard knows me well, so leave it with him if I do not answer.";

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

  it("hides email addresses, phone numbers and postal addresses before anything leaves the page", () => {
    document.title = "Priya Sharma · priya@example.com · StoreMink";
    window.history.replaceState(
      null,
      "",
      "/dashboard/users?q=priya%40example.com&filter=all",
    );
    // The Customers and Orders cells' own shapes: initials, a name and the
    // contact detail in separate elements of one cell.
    document.body.innerHTML = `
      <main>
        <h1>Priya Sharma <span>+91 98765 43210</span></h1>
        <div role="alert">Invite sent to rahul@example.com</div>
        <table><tbody>
          <tr>
            <td><div><span>PS</span><div><strong>Priya Sharma</strong><a href="mailto:priya@example.com">priya@example.com</a></div></div></td>
            <td>+919876543210</td>
            <td>25 Oct 2026</td>
          </tr>
          <tr>
            <td>ORD10011027</td>
            <td><span>RS</span><div>Rahul Singh</div><div>9876543210</div></td>
            <td>12 MG Road, Indiranagar, Bengaluru 560038</td>
            <td>₹1,240.5</td>
          </tr>
        </tbody></table>
        <form>
          <label for="a1">Address line 1</label><input id="a1" value="12 MG Road" />
          <label for="city">City</label><input id="city" value="Bengaluru" />
          <label for="ph">Phone</label><input id="ph" value="098765-43210" />
          <label for="n">Notes</label><textarea id="n">Leave it with the guard at Flat 4B, Sunshine Apartments</textarea>
        </form>
        <div role="dialog"><h2>Call <span>022 2345 6789</span></h2></div>
      </main>
    `;
    expect(readMinkScreen()).toEqual({
      title: "Priya Sharma · [email hidden] · StoreMink",
      headings: ["Priya Sharma [phone hidden]"],
      query: { q: "[email hidden]", filter: "all" },
      dialog: "Call [phone hidden]",
      notice: "Invite sent to [email hidden]",
      rows: [
        "PS Priya Sharma [email hidden] · [phone hidden] · 25 Oct 2026",
        "ORD10011027 · RS Rahul Singh [phone hidden] · [address hidden] · ₹1,240.5",
      ],
      fields: [
        { label: "Address line 1", value: "[address hidden]" },
        { label: "City", value: "Bengaluru" },
        { label: "Phone", value: "[phone hidden]" },
        { label: "Notes", value: "[address hidden]" },
      ],
    });
  });

  it("masks a cell before cutting it, so no part of an email is left at the cut", () => {
    // The address starts after 48 characters; the cell is cut at 60.
    document.body.innerHTML = `
      <main><table><tbody><tr>
        <td>Customer since 2019, prefers WhatsApp, write to priya.sharma.orders@examplecorp.com</td>
        <td>Active</td>
      </tr></tbody></table></main>
    `;
    const [row] = readMinkScreen()?.rows ?? [];
    expect(row).toBe(
      "Customer since 2019, prefers WhatsApp, write to [email hidd… · Active",
    );
    expect(row).not.toContain("priya");
  });

  it("hides every number in a chain and a PIN followed by a phone, and the server's pass changes nothing", () => {
    // An Enquiries row prints the shopper's message word for word.
    document.body.innerHTML = `
      <main>
        <table><tbody>
          <tr>
            <td>Asha Rao</td>
            <td><span>Hello, please call me on my numbers 9876543210/9123456789 thanks</span></td>
            <td><span>New</span></td>
          </tr>
          <tr>
            <td>Priya</td>
            <td><span>Deliver to Priya Sharma
Lakeview Residency, Indiranagar
Bengaluru 560038
98765 43210</span></td>
            <td><span>New</span></td>
          </tr>
        </tbody></table>
        <form>
          <label for="n">Notes</label><textarea id="n">Call 9876543210/9123456789/9988776655</textarea>
          <textarea aria-label="Note">Priya Sharma
Lakeview Residency, Indiranagar
Bengaluru 560038
98765 43210</textarea>
        </form>
      </main>
    `;
    const screen = readMinkScreen();
    expect(screen).toEqual({
      rows: [
        // Masked whole, then cut at 60: the second number is gone too.
        "Asha Rao · Hello, please call me on my numbers [phone hidden]/[phone h… · New",
        "Priya · [address hidden] · New",
      ],
      fields: [
        {
          label: "Notes",
          value: "Call [phone hidden]/[phone hidden]/[phone hidden]",
        },
        { label: "Note", value: "[address hidden]" },
      ],
    });
    expect(JSON.stringify(screen)).not.toMatch(
      /91234|99887|98765|43210|560038|Lakeview/,
    );
    expect(normalizeMinkScreenContext(screen)).toEqual(screen);
  });

  it("hides only the address in a long note, in a notice and in a field", () => {
    document.body.innerHTML = `
      <main>
        <div role="status">${LONG_NOTE}</div>
        <textarea aria-label="Note">${LONG_NOTE}</textarea>
      </main>
    `;
    const masked =
      "[address hidden]. Please call first. I will be home after six in the evening on most weekdays, and the guard knows me well, so leave it with him if I do not answer.";
    const screen = readMinkScreen();
    expect(screen).toEqual({
      notice: masked,
      fields: [{ label: "Note", value: masked }],
    });
    expect(normalizeMinkScreenContext(screen)).toEqual(screen);
  });
});
