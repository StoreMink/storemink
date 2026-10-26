import { describe, expect, it } from "vitest";
import {
  ADDRESS_HIDDEN,
  EMAIL_HIDDEN,
  PHONE_HIDDEN,
  isAddressLabel,
  redactScreenField,
  redactScreenPath,
  redactScreenText,
} from "./screen-redaction";

// Built from code points, so this file holds no long dash of its own.
const EN_DASH = String.fromCharCode(0x2013);
const NON_BREAKING_HYPHEN = String.fromCharCode(0x2011);
const MINUS_SIGN = String.fromCharCode(0x2212);

/** A 201-character delivery note: an address, then a request. */
const LONG_NOTE =
  "Flat 4B, Sunshine Apartments, 12 MG Road, Indiranagar. Please call first. I will be home after six in the evening on most weekdays, and the guard knows me well, so leave it with him if I do not answer.";
const LONG_NOTE_MASKED = `${ADDRESS_HIDDEN}. Please call first. I will be home after six in the evening on most weekdays, and the guard knows me well, so leave it with him if I do not answer.`;

const PHONES: Array<[string, string]> = [
  ["+91 98765 43210", PHONE_HIDDEN],
  ["098765-43210", PHONE_HIDDEN],
  ["9876543210", PHONE_HIDDEN],
  ["(022) 2345 6789", PHONE_HIDDEN],
  ["+1 415 555 0100", PHONE_HIDDEN],
  // How users.phone is stored, and what the Orders page prints for a POS sale.
  ["+919876543210", PHONE_HIDDEN],
  ["+91-98765-43210", PHONE_HIDDEN],
  ["98765.43210", PHONE_HIDDEN],
  ["919876543210", PHONE_HIDDEN],
  ["022-2345-6789", PHONE_HIDDEN],
  ["+44 20 7946 0958", PHONE_HIDDEN],
  ["(415) 555-0100", PHONE_HIDDEN],
  ["Call 98765 43210 after 6", `Call ${PHONE_HIDDEN} after 6`],
  ["Mob:9876543210", `Mob:${PHONE_HIDDEN}`],
  ["98765-43210/11", `${PHONE_HIDDEN}/11`],
  // Another number beside the phone stays; only the phone goes.
  ["Qty 120 98765 43210", `Qty 120 ${PHONE_HIDDEN}`],
  ["2026 9876543210", `2026 ${PHONE_HIDDEN}`],
  ["98765 43210 120", `${PHONE_HIDDEN} 120`],
  // An older tab's textContent glued the name to the number.
  ["PSPriya Sharma+919876543210", `PSPriya Sharma${PHONE_HIDDEN}`],
  // The documented decision: a bare 10 to 12 digit run is a phone.
  ["123456789012", PHONE_HIDDEN],
  // Numbers joined by "/", ":" or "+" all go in one pass, so the server's
  // second pass finds nothing left.
  ["9876543210/9123456789", `${PHONE_HIDDEN}/${PHONE_HIDDEN}`],
  [
    "Call 9876543210/9123456789/9988776655",
    `Call ${PHONE_HIDDEN}/${PHONE_HIDDEN}/${PHONE_HIDDEN}`,
  ],
  ["98765-43210/91234-56789", `${PHONE_HIDDEN}/${PHONE_HIDDEN}`],
  ["9876543210:9123456789", `${PHONE_HIDDEN}:${PHONE_HIDDEN}`],
  ["9876543210+9123456789", `${PHONE_HIDDEN}${PHONE_HIDDEN}`],
  ["(9876 543 210)/9876543210", `${PHONE_HIDDEN}/${PHONE_HIDDEN}`],
  // Joined by a dash or a dot, with a country code and a dash, or split by
  // the dash a keyboard or word processor typed.
  ["9876543210-9123456789", `${PHONE_HIDDEN}-${PHONE_HIDDEN}`],
  ["9876543210.9123456789", `${PHONE_HIDDEN}.${PHONE_HIDDEN}`],
  ["977-9812345678", PHONE_HIDDEN],
  ["880-1712345678", PHONE_HIDDEN],
  ["0091-9876543210", PHONE_HIDDEN],
  ["98765 - 43210", PHONE_HIDDEN],
  [`98765${EN_DASH}43210`, PHONE_HIDDEN],
  [`98765 ${EN_DASH} 43210`, PHONE_HIDDEN],
  [`98765${NON_BREAKING_HYPHEN}43210`, PHONE_HIDDEN],
  [`98765${MINUS_SIGN}43210`, PHONE_HIDDEN],
  // A word that says a phone number follows, joined to it.
  ["Mob9876543210", `Mob${PHONE_HIDDEN}`],
  ["Mob-98765 43210", `Mob-${PHONE_HIDDEN}`],
  ["Contact-9876543210", `Contact-${PHONE_HIDDEN}`],
  ["Ph#9876543210", `Ph#${PHONE_HIDDEN}`],
  ["Mob 987654 3210", `Mob ${PHONE_HIDDEN}`],
  // No group of a phone is left behind beside another number.
  ["Receipt 123456 98765 43210", `Receipt ${PHONE_HIDDEN}`],
  ["+91 98765 432 10", PHONE_HIDDEN],
  // Digits typed in the shopper's own script.
  ["मेरा नंबर ९८७६५४३२१० है", `मेरा नंबर ${PHONE_HIDDEN} है`],
  ["আমার নম্বর ০১৭১২৩৪৫৬৭৮", `আমার নম্বর ${PHONE_HIDDEN}`],
  ["رقمي ٠٥٠١٢٣٤٥٦٧", `رقمي ${PHONE_HIDDEN}`],
  ["રમેશ ૯૮૭૬૫૪૩૨૧૦", `રમેશ ${PHONE_HIDDEN}`],
];

const EMAILS: Array<[string, string]> = [
  ["priya@example.com", EMAIL_HIDDEN],
  ["Write to priya@example.com.", `Write to ${EMAIL_HIDDEN}.`],
  ["Priya.Sharma+orders@mail.example.co.in", EMAIL_HIDDEN],
  ["o'brien@example.com", EMAIL_HIDDEN],
  // A UPI id carries the phone number.
  ["9876543210@paytm", EMAIL_HIDDEN],
  // Cut short by an older tab: still somebody's address.
  ["priya@examplecorp", EMAIL_HIDDEN],
  ["PSPriya Sharmapriya@example.com", `PSPriya ${EMAIL_HIDDEN}`],
  // Addresses joined to each other all go in one pass.
  ["a@b.com+c@d.com", `${EMAIL_HIDDEN}${EMAIL_HIDDEN}`],
  ["a@b.com+c@d.com+e@f.com", EMAIL_HIDDEN.repeat(3)],
  // A search still being typed, with nothing after its "@" yet.
  ["priya.sharma@", EMAIL_HIDDEN],
  ["प्रिया@gmail.com", EMAIL_HIDDEN],
  ["priya@उदाहरण.भारत", EMAIL_HIDDEN],
];

const ADDRESSES: Array<[string, string]> = [
  ["12 MG Road, Indiranagar, Bengaluru 560038", ADDRESS_HIDDEN],
  ["Bengaluru 560038", ADDRESS_HIDDEN],
  ["Bengaluru - 560038", ADDRESS_HIDDEN],
  ["PIN: 560038", ADDRESS_HIDDEN],
  ["560038, India", ADDRESS_HIDDEN],
  ["Flat 4B, Sunshine Apartments", ADDRESS_HIDDEN],
  ["Plot 45, Sector 18", ADDRESS_HIDDEN],
  // A row: only the cell holding the address goes.
  [
    "Priya Sharma · 12 MG Road, Indiranagar, Bengaluru 560038 · ₹1,240",
    `Priya Sharma · ${ADDRESS_HIDDEN} · ₹1,240`,
  ],
  [
    "ORD10011027 · Ship to Flat 4B, Sunshine Apartments · Paid",
    `ORD10011027 · ${ADDRESS_HIDDEN} · Paid`,
  ],
  // A phone written in groups straight after the PIN does not take the PIN
  // with it and leave the street.
  [
    "Priya Sharma\n4th Cross, Indiranagar\nBengaluru 560038\n98765 43210",
    ADDRESS_HIDDEN,
  ],
  // The PIN is this one's only sign of an address.
  [
    "Priya Sharma\nLakeview Residency, Indiranagar\nBengaluru 560038\n98765 43210",
    ADDRESS_HIDDEN,
  ],
  ["Bengaluru 560038 98765 43210", ADDRESS_HIDDEN],
  // Read as a list of numbers until the phone after the comma is hidden.
  ["Bengaluru 560038,9876543210", ADDRESS_HIDDEN],
  // A PIN after a word in Devanagari, which may end in a vowel sign.
  ["दिल्ली 110001", ADDRESS_HIDDEN],
  ["पुणे 411001", ADDRESS_HIDDEN],
  ["बेंगलुरु - 560038", ADDRESS_HIDDEN],
  ["पता: 12, गांधी नगर, दिल्ली 110001", ADDRESS_HIDDEN],
  // No PIN: an address word next to its number.
  ["#12, 3rd Cross, Koramangala", ADDRESS_HIDDEN],
  ["12/3, 4th Block, Rajajinagar", ADDRESS_HIDDEN],
  ["Flat 302, Tower B, Prestige Lakeside", ADDRESS_HIDDEN],
  ["House no 45, 2nd Main, HSR Layout", ADDRESS_HIDDEN],
  ["B-204, Shanti Society, 2nd Phase", ADDRESS_HIDDEN],
  ["H.No. 12-3-456, Banjara Hills, Hyderabad", ADDRESS_HIDDEN],
  ["12, Rajajinagar, Bengaluru", ADDRESS_HIDDEN],
  ["Shop 12, Green Market, MG Road", ADDRESS_HIDDEN],
  // The accepted cost: a six-digit number beside a word that is not a count,
  // price or reference reads as a PIN, and a place named with its number
  // reads as an address (a POS location "Sector 18, Noida" hides the cashier
  // in its cell too).
  ["Batch 100234", ADDRESS_HIDDEN],
  ["Sector 18, Noida By Asha", ADDRESS_HIDDEN],
];

describe("redactScreenText", () => {
  it.each(PHONES)("hides the phone number in %j", (input, expected) => {
    expect(redactScreenText(input)).toBe(expected);
  });

  it.each(EMAILS)("hides the email address in %j", (input, expected) => {
    expect(redactScreenText(input)).toBe(expected);
  });

  it.each([
    "ORD10011027",
    "SKU100100015",
    "SKU10010001V013",
    // A store past 100,000 orders: the references grow to phone length.
    "ORD10011000003",
    "SKU100110000015",
    "₹1,240.50",
    "₹1,23,456",
    "₹1,240.5",
    "Qty 12",
    "× 2",
    "12.5%",
    "25/10/2026",
    "2026-10-25",
    "10:30",
    "2026-10-25 10:30",
    "25 Oct 2026, 10:30 am",
    "2026",
    "FY 2025-26",
    "10000000-0000-4000-8000-000000000001",
    "123e4567-e89b-12d3-a45f-426614174000",
    // Courier waybills mixed with letters.
    "SF123456789IN",
    "DL1234567890IN",
    "12345",
    // POS receipts and platform invoice numbers.
    "DEL-000042",
    "DEL-123456",
    "SM/2026-27/100000",
    "INV-9876543210",
    // A hyphenated ISBN, and a marketplace order number.
    "978-81-123-4567-8",
    "402-1234567-1234567",
    // An amount, and a 13-digit barcode.
    "1234567890.50",
    "8901234567890",
    "Total 560038.50 paid",
    "@storemink",
    "Buy 2@₹99",
    // What the Orders page prints for a website order: city and state.
    "PS Priya Sharma Bengaluru, Karnataka",
    "Floor Lamp, Brass",
    "Almond Shake (250 ml)",
    "Orders · StoreMink",
    "Pickup · Main Store",
    "Area, landmark, unit or floor (optional)",
    // Six digits beside a count, price or reference word are not a PIN.
    "Order 100234",
    "Invoice 100045",
    "Invoice No. 100045",
    "SKU 123456",
    "Qty 100000",
    "Total 125000",
    "Rs 125000",
    "HSN 210690",
    "Sessions 104321",
    "Views: 123456",
    "123456 views",
    "Visitors 123456 · Orders 120",
    // An address word whose number is not its own.
    "Street Food Masala, 100 g",
    "Floor Mat, Pack of 2",
    "Road Bike, 21 Speed",
    "Floor cushion, set of 2",
    "perfect for street wear, in 3 colours",
    "Stock is near zero for 3 products, restock soon",
    "MG Road, Bengaluru",
    "Add a complete house/flat and street address, city, state, and 6-digit PIN code in Locations.",
  ])("leaves %j alone", (input) => {
    expect(redactScreenText(input)).toBe(input);
  });

  it.each(ADDRESSES)("hides the postal address in %j", (input, expected) => {
    expect(redactScreenText(input)).toBe(expected);
  });

  it("hides every kind in one row and leaves the order details", () => {
    expect(
      redactScreenText(
        "ORD10011027 · RS Rahul Singh +91 98765 43210 · rahul@example.com · Plot 45, Sector 18, Noida 201301 · ₹1,240.5",
      ),
    ).toBe(
      `ORD10011027 · RS Rahul Singh ${PHONE_HIDDEN} · ${EMAIL_HIDDEN} · ${ADDRESS_HIDDEN} · ₹1,240.5`,
    );
  });

  it("hides only the sentence of a long note that reads as an address", () => {
    expect(LONG_NOTE.length).toBeGreaterThan(160);
    expect(redactScreenText(LONG_NOTE)).toBe(LONG_NOTE_MASKED);
    expect(
      redactScreenText(
        "Thanks for the quick reply on the sofa. Please deliver it to 12 MG Road, Indiranagar, Bengaluru on Saturday. I will be home after six in the evening, and the guard knows me well.",
      ),
    ).toBe(
      `Thanks for the quick reply on the sofa. ${ADDRESS_HIDDEN}. I will be home after six in the evening, and the guard knows me well.`,
    );
    const prose =
      "We hand-pour every candle in small batches, so colours can vary a little from the photos. Each one burns for about 40 hours, and the wick is cotton. Store it somewhere cool, away from sunlight.";
    expect(prose.length).toBeGreaterThan(160);
    expect(redactScreenText(prose)).toBe(prose);
  });

  it("hides everything in one pass, so the server's second pass changes nothing", () => {
    for (const input of [
      ...[...PHONES, ...EMAILS, ...ADDRESSES].map(([text]) => text),
      LONG_NOTE,
      "PS Priya Sharma priya@example.com · +919876543210 · 12 MG Road, Indiranagar, Bengaluru 560038",
      "Call 98765 43210, near 12 MG Road, Indiranagar",
      "Hello, please call me on my numbers 9876543210/9123456789 thanks",
      // Once the long address sentence is hidden, what is left is short
      // enough to be judged whole, as the second pass would judge it.
      "Flat 4B, Sunshine Apartments, 12 MG Road, Indiranagar, Bengaluru, Karnataka, next to the big blue gate opposite the old bakery on the corner. Call me, I am at the house. Go to 12 MG Road",
    ]) {
      const once = redactScreenText(input);
      expect(once, input).not.toBe(input);
      expect(redactScreenText(once), input).toBe(once);
    }
  });

  it("masks a long chain of numbers in one quick pass", () => {
    // The server masks before it bounds, and a request may carry 64 KB: a
    // pass repeated until nothing changed took about 18 seconds on this.
    const chain = "9876543210/".repeat(6_000);
    const started = performance.now();
    const masked = redactScreenText(chain);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(masked).not.toMatch(/\d/);
  });
});

describe("redactScreenField", () => {
  it.each([
    "Address line 1",
    "Address line 2",
    "Street address",
    "Delivery address",
    "Landmark",
    "Locality",
    "Pincode",
    "Postal code",
    "Postcode",
    "ZIP",
    "Flat, house no., building",
    "Area",
    "House / flat number and street address",
    "Area, landmark, unit or floor (optional)",
  ])("hides the whole value of a field labelled %j", (label) => {
    expect(isAddressLabel(label)).toBe(true);
    expect(redactScreenField(label, "Indiranagar 2nd Stage")).toBe(
      ADDRESS_HIDDEN,
    );
  });

  it.each([
    ["City", "Bengaluru", "Bengaluru"],
    ["State", "Karnataka", "Karnataka"],
    // An email, web or link address is not a postal one.
    ["Email address", "priya@example.com", EMAIL_HIDDEN],
    ["Link 1 address", "/our-story", "/our-story"],
    ["Link 1 address", "#contact", "#contact"],
    // A web address in an address-labelled field.
    ["Store address", "echoss.storemink.com", "echoss.storemink.com"],
    // A house number written with "#" or "/" is not a web address.
    [
      "House / flat number and street address",
      "#12, 3rd Cross, Indiranagar",
      ADDRESS_HIDDEN,
    ],
    ["Address line 1", "#12, 3rd Cross, Indiranagar", ADDRESS_HIDDEN],
    [
      "Business address",
      "#45, 2nd Main, Jayanagar 4th Block, Bengaluru",
      ADDRESS_HIDDEN,
    ],
    ["Business address", "/2, Ganesh Peth, Pune", ADDRESS_HIDDEN],
    // Only the label says these are addresses.
    ["Address line 1", "#12, Lakeview Residency, Indiranagar", ADDRESS_HIDDEN],
    ["Business address", "/2, Lakeview Residency, Pune", ADDRESS_HIDDEN],
    // A checkbox reads "on" or "off", never an address.
    ["Show business address", "on", "on"],
    ["Search", "priya@example.com", EMAIL_HIDDEN],
    ["Search", "98765 43210", PHONE_HIDDEN],
    ["Search", "ORD10011027", "ORD10011027"],
    [
      "Notes",
      "Deliver to 12 MG Road, Bengaluru 560038 after 6",
      ADDRESS_HIDDEN,
    ],
    // A long note keeps its request; only the address goes.
    ["Note", LONG_NOTE, LONG_NOTE_MASKED],
  ])("masks a %j field holding %j as %j", (label, value, expected) => {
    expect(redactScreenField(label, value)).toBe(expected);
  });
});

describe("redactScreenPath", () => {
  it("masks what a search box wrote into the address bar", () => {
    expect(redactScreenPath("/dashboard/users?q=priya%40example.com")).toBe(
      "/dashboard/users?q=%5Bemail+hidden%5D",
    );
    expect(redactScreenPath("/dashboard/users?q=98765+43210&filter=all")).toBe(
      "/dashboard/users?q=%5Bphone+hidden%5D&filter=all",
    );
    // A search paused right after its "@".
    expect(redactScreenPath("/dashboard/users?q=priya.sharma%40")).toBe(
      "/dashboard/users?q=%5Bemail+hidden%5D",
    );
  });

  it.each([
    "/dashboard",
    "/dashboard/products/one?tab=inventory",
    "/dashboard/orders?status=pending&from=2026-10-01&q=ORD10011027",
  ])("returns %j exactly as it was", (path) => {
    expect(redactScreenPath(path)).toBe(path);
  });
});
