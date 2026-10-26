// Minimal SSRF guard for upstream URLs an admin adds. Resolve the host and refuse addresses that
// point back into the node or at cloud metadata: loopback, link-local (169.254.0.0/16, which holds
// 169.254.169.254) and unspecified. Hosts matching UPSTREAM_ALLOWED_HOSTS (default
// *.svc.cluster.local, our own in-cluster servers) skip the address check.
// Checked when a server is added or edited, and again before every (re)connect.
// Private ranges (10/8 etc.) are allowed on purpose: in-cluster Services live there.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

const blocked = new BlockList();
blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local, cloud metadata
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // unspecified / "this host"
blocked.addAddress("::1", "ipv6"); // loopback
blocked.addAddress("::", "ipv6"); // unspecified
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local

export function isBlockedAddress(address: string): boolean {
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) must be judged as the IPv4 address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], "ipv4");
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) return blocked.check(address, "ipv6");
  return true; // not an IP at all: refuse rather than guess
}

export function hostAllowlisted(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return patterns.some((p) => {
    const pat = p.trim().toLowerCase();
    if (!pat) return false;
    return pat.startsWith("*.") ? h.endsWith(pat.slice(1)) && h.length > pat.length - 1 : h === pat;
  });
}

// Returns null if the URL is acceptable, otherwise a reason an admin can read.
export async function checkUpstreamUrl(rawUrl: string, allowHosts: string[], lookup: Lookup = defaultLookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "not a valid URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https URLs are allowed";
  const host = url.hostname.replace(/^\[|\]$/g, ""); // IPv6 literals come bracketed
  if (hostAllowlisted(host, allowHosts)) return null;

  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host)).map((a) => a.address);
    } catch {
      return `cannot resolve host '${host}'`;
    }
  }
  const bad = addresses.find(isBlockedAddress);
  return bad ? `blocked by SSRF guard: '${host}' resolves to ${bad} (loopback, link-local/metadata or unspecified)` : null;
}
