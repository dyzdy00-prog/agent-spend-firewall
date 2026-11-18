// Outbound HTTP for the firewall with SSRF protection (#8).
// The address check runs inside the DNS lookup used for the connection itself, so a name cannot
// resolve to a public address for the check and to a private one for the request (DNS rebinding).
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class BlockedAddressError extends Error {}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, documentation, multicast, reserved and unspecified addresses. */
export function isBlockedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (v4ToInt(base) >>> (32 - bits)));
  }
  if (!net.isIPv6(ip)) return true;
  const a = ip.toLowerCase();
  const mapped = a.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);
  if (a === "::" || a === "::1") return true;
  const first = parseInt(a.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (a.startsWith("2001:db8:")) return true;   // documentation
  // ::ffff:7f00:1 style (hex-mapped IPv4)
  const hexMapped = a.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: dns.LookupOptions, cb: LookupCb): void => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err, "", 0);
      const list = addrs as dns.LookupAddress[];
      if (!allowPrivate && list.some((x) => isBlockedAddress(x.address))) {
        return cb(Object.assign(new BlockedAddressError("blocked address"), { code: "EBLOCKED" }), "", 0);
      }
      if (options.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

export type Raw = { status: number; headers: Headers; body: string };

/**
 * GET without following redirects. Literal IP hosts are checked directly; names are checked in the
 * connection's own lookup. `allowPrivate` is set only for hosts the owner allowlisted (the local bench).
 */
export function guardedGet(url: string, headers: Record<string, string>, opts: { allowPrivate: boolean; timeoutMs: number; maxBody: number }): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const literal = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal) && !opts.allowPrivate && isBlockedAddress(literal)) {
      return reject(new BlockedAddressError("blocked address"));
    }
    const req = lib.request(u, { method: "GET", headers, lookup: guardedLookup(opts.allowPrivate) as never, timeout: opts.timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (c: Buffer) => {
        if (total >= opts.maxBody) return;
        chunks.push(c);
        total += c.length;
        if (total >= opts.maxBody) res.destroy();
      });
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
        }
        resolve({ status: res.statusCode ?? 502, headers: h, body: Buffer.concat(chunks).subarray(0, opts.maxBody).toString("utf8") });
      };
      res.on("end", done);
      res.on("close", done);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject((e as { code?: string }).code === "EBLOCKED" ? new BlockedAddressError("blocked address") : e));
    req.end();
  });
}
