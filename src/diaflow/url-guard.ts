/**
 * SSRF guard for URLs this server downloads on a user/teammate's behalf
 * (remote avatar images, chat attachments).
 *
 * Blocks obviously-internal targets (loopback/private/link-local/ULA/metadata
 * hostnames) both when given as literal IPs and after DNS resolution, so a
 * hostname that only *resolves* to an internal address is also rejected.
 *
 * Known limitation: there is a residual DNS-rebinding TOCTOU window between
 * this check and the actual `fetch()` call (the name could re-resolve to a
 * different, internal address by the time the download happens). Callers
 * should also pass `{ redirect: "error" }` to the download fetch so a 3xx
 * response can't be used to pivot to an internal host after the check.
 */

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);

export function isBlockedAddress(ip: string): boolean {
  if (ip.includes(":")) return isBlockedIPv6(ip);
  return isBlockedIPv4(ip);
}

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c, d] = nums;
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0 && b === 0 && c === 0 && d === 0) return true; // 0.0.0.0 unspecified
  return false;
}

function expandIPv6Groups(ip: string): number[] {
  const withoutZone = ip.split("%")[0];
  const [head, tail] = withoutZone.includes("::") ? withoutZone.split("::") : [withoutZone, undefined];
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const middle: string[] = new Array(Math.max(missing, 0)).fill("0");
  return [...headParts, ...middle, ...tailParts].map((g) => parseInt(g || "0", 16));
}

function isBlockedIPv6(ip: string): boolean {
  const groups = expandIPv6Groups(ip);
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g))) return true;
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true; // ::1
  const first = groups[0];
  if ((first >> 9) === 0b1111110) return true; // fc00::/7 (ULA)
  if ((first >> 6) === 0b1111111010) return true; // fe80::/10 (link-local)
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKED_HOSTNAMES.has(lower) || lower.endsWith(".internal");
}

export interface AssertSafeFetchUrlOptions {
  lookup?: (host: string) => Promise<{ address: string }[]>;
}

const defaultLookup = async (host: string): Promise<{ address: string }[]> => {
  const dns = await import("node:dns");
  return dns.promises.lookup(host, { all: true });
};

export async function assertSafeFetchUrl(rawUrl: string, opts: AssertSafeFetchUrlOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`unsafe/blocked URL: not a valid URL`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsafe/blocked URL: unsupported scheme "${url.protocol}"`);
  }

  const hostname = url.hostname;
  if (isBlockedHostname(hostname)) {
    throw new Error(`unsafe/blocked URL: hostname "${hostname}" is not allowed`);
  }

  // If the hostname is a literal IP, check it directly without a DNS lookup.
  const literalCheck = hostname.includes(":") ? hostname.replace(/^\[|\]$/g, "") : hostname;
  const looksLikeIp = /^[0-9.]+$/.test(literalCheck) || literalCheck.includes(":");
  if (looksLikeIp && isBlockedAddress(literalCheck)) {
    throw new Error(`unsafe/blocked URL: address "${literalCheck}" is not allowed`);
  }
  if (looksLikeIp) return;

  const lookup = opts.lookup ?? defaultLookup;
  const resolved = await lookup(hostname);
  for (const { address } of resolved) {
    if (isBlockedAddress(address)) {
      throw new Error(`unsafe/blocked URL: "${hostname}" resolves to blocked address "${address}"`);
    }
  }
}
