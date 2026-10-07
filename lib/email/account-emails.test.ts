import { describe, expect, it } from "vitest";
import type { StoreBrand } from "@/lib/store/brand";
import {
  buildPasswordResetEmail,
  buildPosCredentialResetEmail,
  buildPosStaffInviteEmail,
  buildStaffInviteEmail,
} from "./account-emails";

const BRAND: StoreBrand = {
  name: "Acme Juice",
  logoUrl: null,
  primaryColor: "#2f6b3a",
  tagline: null,
  blurb: null,
  legalName: "Acme Juice Pvt Ltd",
  creditLine: null,
  email: null,
  phone: null,
  hours: null,
  social: { instagram: null, youtube: null, whatsapp: null },
  badges: [],
  domain: "acmejuice.in",
};

const LONG_DASH = /[\u2013\u2014]/;

function staffInvite(
  overrides: Partial<Parameters<typeof buildStaffInviteEmail>[0]> = {},
) {
  return buildStaffInviteEmail({
    brand: BRAND,
    firstName: "Priya",
    lastName: "Sharma",
    email: "priya@acmejuice.in",
    role: "member",
    tempPassword: "Tq7#mZ2pLx&9abcd",
    signInUrl: "https://acme.storemink.com/dashboard",
    ...overrides,
  });
}

function allFour() {
  return [
    staffInvite(),
    buildPasswordResetEmail({
      brand: BRAND,
      link: "https://auth.storemink.com/reset?oobCode=x&mode=resetPassword",
    }),
    buildPosStaffInviteEmail({
      brand: BRAND,
      name: "Rohan",
      role: "cashier",
      link: "https://acme.storemink.com/pos/register?token=t1",
    }),
    buildPosCredentialResetEmail({
      brand: BRAND,
      name: "Rohan",
      link: "https://acme.storemink.com/pos/reset?token=t2",
    }),
  ];
}

describe("account emails: shared rules", () => {
  it("are complete single documents in the standard frame", () => {
    for (const email of allFour()) {
      expect(email.html.match(/<!DOCTYPE html>/g)).toHaveLength(1);
      // The serif headline the composed layout always carries.
      expect(email.html).toContain('class="sm-email-h1 sm-serif"');
      expect(email.html).toContain("The Acme Juice team");
    }
  });

  it("contain no long dash in the subject or the body", () => {
    for (const email of allFour()) {
      expect(`${email.subject}\n${email.html}`).not.toMatch(LONG_DASH);
    }
  });

  it("carry no emoji in the subject", () => {
    for (const email of allFour()) {
      expect(email.subject).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("escape the store name in the body but keep the subject a plain header", () => {
    const brand = { ...BRAND, name: "Tom & <Jerry>" };
    const invite = buildPosStaffInviteEmail({
      brand,
      name: "Rohan",
      role: "cashier",
      link: "https://acme.storemink.com/pos/register?token=t1",
    });
    expect(invite.subject).toBe("You've been added to Tom & <Jerry> POS");
    expect(invite.html).not.toContain("<Jerry>");
    expect(invite.html).toContain("Tom &amp; &lt;Jerry&gt;");
  });
});

describe("buildStaffInviteEmail", () => {
  it("has a sentence-case subject naming the store dashboard", () => {
    expect(staffInvite().subject).toBe(
      "You're invited to the Acme Juice dashboard",
    );
  });

  it("shows the temporary password, the sign-in email and the role", () => {
    const { html } = staffInvite();
    expect(html).toContain("Temporary password");
    // Escaped: the generator's alphabet includes `&`.
    expect(html).toContain("Tq7#mZ2pLx&amp;9abcd");
    expect(html).toContain("priya@acmejuice.in");
    expect(html).toContain("Member");
    expect(html).toContain("Hello Priya Sharma,");
    expect(html).toMatch(/set a new password the first time you sign in/);
  });

  it("links the button to the store's dashboard", () => {
    expect(staffInvite().html).toContain(
      'href="https://acme.storemink.com/dashboard"',
    );
  });

  it("escapes names, the role and the address", () => {
    const { html } = staffInvite({
      firstName: "<img src=x onerror=alert(1)>",
      lastName: "<script>",
      email: 'a"b@example.com',
      role: "<b>boss</b>",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>boss</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("a&quot;b@example.com");
  });

  it("greets without a name when none is usable", () => {
    const { html } = staffInvite({ firstName: "  ", lastName: null });
    expect(html).toContain("Hello,");
  });

  it("drops the button rather than render an unsafe link", () => {
    const { html } = staffInvite({ signInUrl: "javascript:alert(1)" });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Sign in to the dashboard");
    // The credentials still arrive.
    expect(html).toContain("Temporary password");
  });

  it("reads the role with the right article", () => {
    expect(staffInvite({ role: "superadmin" }).html).toContain(
      "as a superadmin",
    );
    expect(staffInvite({ role: "admin" }).html).toContain("as an admin");
  });
});

describe("buildPasswordResetEmail", () => {
  const link = "https://auth.storemink.com/reset?oobCode=x&mode=resetPassword";

  it("names the store in the subject", () => {
    expect(buildPasswordResetEmail({ brand: BRAND, link }).subject).toBe(
      "Reset your Acme Juice password",
    );
  });

  it("carries the link as the button and as a plain fallback, escaped", () => {
    const { html } = buildPasswordResetEmail({ brand: BRAND, link });
    const escaped = link.replace(/&/g, "&amp;");
    expect(html.split(`href="${escaped}"`).length - 1).toBe(2);
    expect(html).toContain("Or paste this link into your browser");
    expect(html).toContain("Reset password");
    expect(html).toMatch(/safely ignore this email/);
  });

  it("renders no link at all for a non-http target", () => {
    const { html } = buildPasswordResetEmail({
      brand: BRAND,
      link: "javascript:alert(1)",
    });
    expect(html).not.toContain("javascript:");
  });
});

describe("buildPosStaffInviteEmail", () => {
  const link = "https://acme.storemink.com/pos/register?token=t1";

  it("keeps the subject and points the button at registration", () => {
    const email = buildPosStaffInviteEmail({
      brand: BRAND,
      name: "Rohan",
      role: "manager",
      link,
    });
    expect(email.subject).toBe("You've been added to Acme Juice POS");
    expect(email.html).toContain(`href="${link}"`);
    expect(email.html).toContain("Complete registration");
    expect(email.html).toContain("as a manager");
    expect(email.html).toMatch(/expires in 7 days/);
    expect(email.html).toMatch(/8-digit PIN/);
  });

  it("escapes the name and the role", () => {
    const { html } = buildPosStaffInviteEmail({
      brand: BRAND,
      name: "<b>Rohan</b>",
      role: "<i>cashier</i>",
      link,
    });
    expect(html).not.toContain("<b>Rohan</b>");
    expect(html).not.toContain("<i>cashier</i>");
    expect(html).toContain("Hello &lt;b&gt;Rohan&lt;/b&gt;,");
  });
});

describe("buildPosCredentialResetEmail", () => {
  const link = "https://acme.storemink.com/pos/reset?token=t2";

  it("keeps the subject, the link and the one-hour single-use note", () => {
    const email = buildPosCredentialResetEmail({
      brand: BRAND,
      name: "Rohan",
      link,
    });
    expect(email.subject).toBe("Reset your Acme Juice POS access");
    expect(email.html).toContain(`href="${link}"`);
    expect(email.html).toContain("Reset PIN or password");
    expect(email.html).toMatch(/expires in 1 hour and can be used once/);
    expect(email.html).toMatch(
      /you can safely ignore this email\. Nothing has changed\./,
    );
  });

  it("escapes the staff name", () => {
    const { html } = buildPosCredentialResetEmail({
      brand: BRAND,
      name: "<script>x</script>",
      link,
    });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});
