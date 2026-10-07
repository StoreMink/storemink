import { beforeEach, describe, expect, it, vi } from "vitest";

const sendEmail = vi.fn();
vi.mock("./send", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

import { buildOperatorOtpEmail, sendOperatorOtpEmail } from "./operator-otp";
import { PLATFORM_EMAIL_MARK_URL, STOREMINK_PURPLE } from "./platform-brand";

const LONG_DASHES = /[\u2014\u2013]/;

beforeEach(() => {
  vi.clearAllMocks();
  sendEmail.mockResolvedValue({ sent: true });
  vi.stubEnv("RESEND_API_KEY", "re_live_key");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("buildOperatorOtpEmail", () => {
  it("leads the subject with the code, so the inbox list shows it", () => {
    const { subject } = buildOperatorOtpEmail("731904");
    expect(subject).toBe("731904 is your StoreMink sign-in code");
  });

  it("renders the standard design with the code, expiry and StoreMink identity", () => {
    const { html } = buildOperatorOtpEmail("731904");

    expect(html).toContain("Your sign-in code");
    expect(html).toContain("731904");
    expect(html).toContain("expires in 10 minutes");
    expect(html).toContain("No one can sign in without it.");
    expect(html).toContain(PLATFORM_EMAIL_MARK_URL);
    // The official lockup: "Store" in ink, "Mink" in the brand purple.
    expect(html).toContain(
      `Store<span style="color:${STOREMINK_PURPLE};">Mink</span>`,
    );
    expect(html).toContain("#faf9f5");
  });

  it("escapes the code rather than trusting it as markup", () => {
    const { html } = buildOperatorOtpEmail("<script>x</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never contains a long dash in the subject or body", () => {
    const { subject, html } = buildOperatorOtpEmail("731904");
    expect(subject).not.toMatch(LONG_DASHES);
    expect(html).not.toMatch(LONG_DASHES);
  });
});

describe("sendOperatorOtpEmail", () => {
  it("sends through the choke point as platform security mail", async () => {
    const result = await sendOperatorOtpEmail("op@storemink.com", "731904");

    expect(result).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledWith({
      to: "op@storemink.com",
      from: expect.stringMatching(/^StoreMink <security@/),
      subject: "731904 is your StoreMink sign-in code",
      html: buildOperatorOtpEmail("731904").html,
      mailer: "operator_otp",
      // Someone is waiting at a login screen: a historic bounce must not
      // withhold the code.
      ignoreSuppression: true,
    });
  });

  it("reports an unsent mail without throwing", async () => {
    sendEmail.mockResolvedValue({ sent: false, error: "boom" });
    await expect(
      sendOperatorOtpEmail("op@storemink.com", "731904"),
    ).resolves.toEqual({ sent: false });
  });

  it.each(["", "re_placeholder_key"])(
    "logs the code instead of sending when Resend is not configured (%j)",
    async (key) => {
      vi.stubEnv("RESEND_API_KEY", key);

      const result = await sendOperatorOtpEmail("op@storemink.com", "731904");

      expect(result).toEqual({ sent: false });
      expect(sendEmail).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining("731904"),
      );
    },
  );
});
