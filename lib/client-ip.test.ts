import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientIp, clientIpOrNull } from "./client-ip";

// Our load balancer's forwarding-rule address, as cloudbuild.yaml sets it.
const LB = "136.69.75.127";
const CLIENT = "203.0.113.7";

function request(xff?: string, extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra);
  if (xff !== undefined) headers.set("x-forwarded-for", xff);
  return headers;
}

afterEach(() => vi.unstubAllEnvs());

describe("clientIp behind Google's load balancer", () => {
  beforeEach(() => vi.stubEnv("DOMAIN_LB_IP", LB));

  it("takes the address the load balancer saw on a normal request", () => {
    // A browser sends no X-Forwarded-For; the load balancer writes
    // `<client-ip>,<its own address>`.
    expect(clientIp(request(`${CLIENT},${LB}`))).toBe(CLIENT);
    expect(clientIp(request(`${CLIENT}, ${LB}`))).toBe(CLIENT);
    expect(clientIpOrNull(request(`${CLIENT}, ${LB}`))).toBe(CLIENT);
  });

  it("★★ ignores whatever X-Forwarded-For the caller forged", () => {
    // The load balancer APPENDS to the caller's header, so a forged value
    // stays on the left, including one that imitates the load balancer.
    for (const forged of [
      "1.2.3.4",
      "10.0.0.1, 8.8.8.8",
      `9.9.9.9, ${LB}`,
      "not-an-address",
    ]) {
      expect(clientIp(request(`${forged}, ${CLIENT}, ${LB}`))).toBe(CLIENT);
    }
  });

  it("gives one caller one rate-limit key however often it changes the forged value", () => {
    const keys = new Set(
      Array.from({ length: 20 }, (_, n) =>
        clientIp(request(`198.51.100.${n}, ${CLIENT}, ${LB}`)),
      ),
    );
    expect([...keys]).toEqual([CLIENT]);
  });

  it("never reads x-real-ip, which nothing on Google Cloud sets", () => {
    expect(
      clientIp(request(`${CLIENT}, ${LB}`, { "x-real-ip": "9.9.9.9" })),
    ).toBe(CLIENT);
    expect(clientIp(request(undefined, { "x-real-ip": "9.9.9.9" }))).toBe(
      "unknown",
    );
  });

  it("finds the load balancer's entry when another hop follows it", () => {
    const GOOGLE_HOP = "35.191.0.1";
    expect(clientIp(request(`${CLIENT}, ${LB}, ${GOOGLE_HOP}`))).toBe(CLIENT);
    // A forged copy of the load balancer's address sits further left.
    expect(
      clientIp(request(`9.9.9.9, ${LB}, ${CLIENT}, ${LB}, ${GOOGLE_HOP}`)),
    ).toBe(CLIENT);
  });

  it("takes the first entry when the request did not come through it, as before this fix", () => {
    // A direct *.run.app request names its caller in a single entry. Several
    // entries without the load balancer's address mean it was not in the path:
    // the first entry keeps every visitor apart.
    expect(clientIp(request(CLIENT))).toBe(CLIENT);
    expect(clientIp(request(`1.2.3.4, ${CLIENT}`))).toBe("1.2.3.4");
  });
});

describe("★★ a wrong DOMAIN_LB_IP never gives every visitor one key", () => {
  it("keeps two visitors through the load balancer apart", () => {
    for (const wrong of ["", "192.0.2.1"]) {
      vi.stubEnv("DOMAIN_LB_IP", wrong);
      const first = clientIp(request(`198.51.100.1, ${LB}`));
      const second = clientIp(request(`198.51.100.2, ${LB}`));
      expect(first).not.toBe(second);
      expect([first, second]).not.toContain(LB);
    }
  });
});

describe("clientIp in local development", () => {
  it("uses the socket address Next.js puts in the header, with or without DOMAIN_LB_IP", () => {
    for (const lb of ["", LB]) {
      vi.stubEnv("DOMAIN_LB_IP", lb);
      expect(clientIp(request("::1"))).toBe("::1");
      expect(clientIp(request("127.0.0.1"))).toBe("127.0.0.1");
    }
  });
});

describe("a request that names no address", () => {
  it("is 'unknown' as a rate-limit key and null as evidence", () => {
    for (const headers of [request(), request(""), request(" , ")]) {
      expect(clientIp(headers)).toBe("unknown");
      expect(clientIpOrNull(headers)).toBeNull();
    }
  });

  it("tolerates a header source whose get() returns undefined", () => {
    // lib/legal's tests stand a plain Map in for next/headers.
    expect(clientIpOrNull(new Map<string, string>())).toBeNull();
  });
});

describe("★ a header that does not end in DOMAIN_LB_IP is reported", () => {
  // Then every visitor through the load balancer shares one key, so the first
  // such request on each Cloud Run instance logs one error line. Each test
  // loads the module afresh, because the report is once per instance.
  const IPV6_FRONTEND = "2600:1901:0:1::1";
  let errors: ReturnType<typeof vi.spyOn>;

  async function freshInstance() {
    vi.resetModules();
    return import("./client-ip");
  }

  beforeEach(() => {
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it("once per instance on Cloud Run, and every visitor keeps a key of their own", async () => {
    vi.stubEnv("K_SERVICE", "storemink-web-prod");
    vi.stubEnv("DOMAIN_LB_IP", LB);
    const instance = await freshInstance();
    // An IPv6 frontend's address is not DOMAIN_LB_IP: the first entry is used,
    // so visitors are not all given the frontend's one address.
    expect(instance.clientIp(request(`${CLIENT}, ${IPV6_FRONTEND}`))).toBe(
      CLIENT,
    );
    expect(instance.clientIp(request(`198.51.100.9, ${IPV6_FRONTEND}`))).toBe(
      "198.51.100.9",
    );
    expect(errors).toHaveBeenCalledTimes(1);
    const line = String(errors.mock.calls[0]?.[0]);
    expect(line).toContain(
      "client-ip: X-Forwarded-For does not end in DOMAIN_LB_IP",
    );
    expect(line).toContain(IPV6_FRONTEND);
    expect(line).toContain(LB);
  });

  it("when DOMAIN_LB_IP is empty on Cloud Run", async () => {
    vi.stubEnv("K_SERVICE", "storemink-web-prod");
    vi.stubEnv("DOMAIN_LB_IP", "");
    const instance = await freshInstance();
    expect(instance.clientIp(request(`${CLIENT}, ${LB}`))).toBe(CLIENT);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("(empty)");
  });

  it("never for a request through the load balancer or a direct one", async () => {
    vi.stubEnv("K_SERVICE", "storemink-web-prod");
    vi.stubEnv("DOMAIN_LB_IP", LB);
    const instance = await freshInstance();
    instance.clientIp(request(`${CLIENT}, ${LB}`));
    instance.clientIp(request(`1.2.3.4, ${CLIENT}, ${LB}`));
    // A direct *.run.app request names only its caller.
    instance.clientIp(request(CLIENT));
    expect(errors).not.toHaveBeenCalled();
  });

  it("never off Cloud Run (local development, tests)", async () => {
    vi.stubEnv("K_SERVICE", undefined);
    vi.stubEnv("DOMAIN_LB_IP", "");
    const instance = await freshInstance();
    instance.clientIp(request(`1.2.3.4, ${CLIENT}`));
    instance.clientIp(request("::1"));
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("the deploy keeps the rule working", () => {
  it("★ gives every web revision the load balancer's address", () => {
    const yaml = readFileSync(join(process.cwd(), "cloudbuild.yaml"), "utf8");
    expect(yaml).toMatch(
      /--set-env-vars=\S*\bDOMAIN_LB_IP=\$\{_DOMAIN_LB_IP\}/,
    );
    expect(yaml).toMatch(/^\s+_DOMAIN_LB_IP: \d{1,3}(?:\.\d{1,3}){3}\s*$/m);
  });
});
