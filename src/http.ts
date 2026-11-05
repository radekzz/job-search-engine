import { lookup } from 'node:dns/promises';
import net from 'node:net';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Politeness: minimum gap between two requests to the same host.
const HOST_GAP_MS: Record<string, number> = { 'www.linkedin.com': 2500 };
const DEFAULT_GAP_MS = 1200;
const lastHit = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function throttle(host: string): Promise<void> {
  const gap = HOST_GAP_MS[host] ?? DEFAULT_GAP_MS;
  const prev = lastHit.get(host) ?? Promise.resolve();
  // Chain per host so parallel sources hitting the same host queue up.
  const next = prev.then(() => sleep(gap));
  lastHit.set(host, next);
  await prev;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`HTTP ${status} ${url}`);
    this.status = status;
  }
}

export async function fetchText(url: string, init: RequestInit = {}, retries = 2): Promise<string> {
  return (await fetchPage(url, init, retries)).text;
}

// ---------------------------------------------------------------- SSRF guard
// URLs come from scraped data (apply links, guessed domains, redirects) – never let them reach
// localhost / the LAN / link-local / cloud metadata. Applied to every request and every redirect hop.
export class BlockedUrlError extends Error {}

// Two separate lists: Node's BlockList treats IPv4 and IPv4-mapped IPv6 as equivalent, so mixing
// "::ffff:0:0/96" into one list would block every IPv4 address.
const BLOCKED4 = new net.BlockList();
for (const [n, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) BLOCKED4.addSubnet(n, p, 'ipv4');
const BLOCKED6 = new net.BlockList();
for (const [n, p] of [['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32]] as const) BLOCKED6.addSubnet(n, p, 'ipv6');

/** IPv6 text → 8 hextets (handles "::" and a dotted IPv4 tail). */
function hextets(ip: string): number[] {
  let s = ip.toLowerCase().split('%')[0];
  const dotted = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/)?.[1];
  if (dotted) {
    const [a, b, c, d] = dotted.split('.').map(Number);
    s = s.slice(0, -dotted.length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail = ''] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = s.includes('::') && tail ? tail.split(':') : [];
  const mid = s.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...mid, ...t].map((x) => parseInt(x || '0', 16));
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return BLOCKED4.check(ip, 'ipv4');
  const w = hextets(ip);
  if (w.length !== 8 || w.some((x) => Number.isNaN(x))) return true; // unparseable → refuse
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (zero(0, 8) || (zero(0, 7) && w[7] === 1)) return true; // :: and ::1
  // IPv6 forms that embed an IPv4 address: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d
  const embeds = (zero(0, 5) && (w[5] === 0xffff || w[5] === 0)) || (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6));
  if (embeds) return BLOCKED4.check(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`, 'ipv4');
  return BLOCKED6.check(ip, 'ipv6');
}

async function assertPublicUrl(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedUrlError(`Nepovolený protokol: ${u.protocol}`);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home|arpa)$/.test(host) || !host.includes('.') && !net.isIP(host))
    throw new BlockedUrlError(`Lokální adresa zablokována: ${host}`);
  const addrs = net.isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(isPrivateIp)) throw new BlockedUrlError(`Privátní adresa zablokována: ${host}`);
}

const MAX_REDIRECTS = 5;

/** Like fetchText, but also returns the final URL after redirects. */
export async function fetchPage(url: string, init: RequestInit = {}, retries = 2): Promise<{ text: string; url: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      // follow redirects manually so every hop passes the SSRF guard
      let current = new URL(url);
      for (let hop = 0; ; hop++) {
        await assertPublicUrl(current);
        await throttle(current.host);
        const res = await fetch(current, {
          ...init,
          redirect: 'manual',
          signal: AbortSignal.timeout(25_000),
          headers: {
            'User-Agent': UA,
            'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
            Accept: 'text/html,application/json,application/xml;q=0.9,*/*;q=0.8',
            ...(init.headers ?? {}),
          },
        });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          if (hop >= MAX_REDIRECTS) throw new HttpError(310, url);
          current = new URL(location, current);
          // 303 (and historically 301/302 after POST) switch to GET
          if (res.status === 303) init = { ...init, method: 'GET', body: undefined };
          continue;
        }
        if (res.status === 429 || res.status >= 500) throw new HttpError(res.status, url);
        if (!res.ok) throw new HttpError(res.status, url); // 4xx other than 429: no retry
        return { text: await res.text(), url: current.toString() };
      }
    } catch (err) {
      if (err instanceof BlockedUrlError) throw err;
      const retryable = !(err instanceof HttpError) || err.status === 429 || err.status >= 500;
      if (!retryable || attempt >= retries) throw err;
      await sleep(3000 * (attempt + 1));
    }
  }
}

export async function fetchJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
  return JSON.parse(await fetchText(url, { ...init, headers: { Accept: 'application/json', ...(init.headers ?? {}) } })) as T;
}

/** Set/replace a query param on a URL (used for pagination). */
export function withParam(url: string, key: string, value: string | number): string {
  const u = new URL(url);
  u.searchParams.set(key, String(value));
  return u.toString();
}
