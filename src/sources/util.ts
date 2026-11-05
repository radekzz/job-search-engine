import * as cheerio from 'cheerio';
import { fetchText } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob, Salary, SalaryPeriod, WorkMode } from '../types.ts';

// Accepts anything – external JSON sometimes has objects/arrays where a string is expected.
export const clean = (s: unknown) =>
  (typeof s === 'string' ? s : typeof s === 'number' ? String(s) : Array.isArray(s) ? s.filter((x) => typeof x === 'string').join(', ') : '').replace(/[​-‍]/g, '').replace(/\s+/g, ' ').trim();

/** HTML -> readable plain text (block elements become newlines). */
export function htmlToText(html: string | undefined | null, max = 20_000): string {
  if (!html) return '';
  // Some APIs double-encode HTML (&lt;p&gt;)
  const decoded = /&lt;\w/.test(html) ? cheerio.load(`<div>${html}</div>`)('div').text() : html;
  const $ = cheerio.load(`<div id="root">${decoded}</div>`);
  $('script,style,noscript,svg,iframe').remove();
  $('br').replaceWith('\n');
  $('p,div,li,h1,h2,h3,h4,h5,tr,section').each((_, el) => {
    $(el).append('\n');
  });
  return $('#root')
    .text()
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
    .slice(0, max);
}

export function absUrl(href: string | undefined, base: string): string {
  if (!href) return base;
  try {
    return new URL(href, base).toString();
  } catch {
    return base;
  }
}

/** Remove tracking query params so the same offer keeps the same URL across scans. */
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export function periodFrom(s: string | undefined): SalaryPeriod | undefined {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v.startsWith('hour')) return 'hour';
  if (v.startsWith('day')) return 'day';
  if (v.startsWith('month')) return 'month';
  if (v.startsWith('year') || v.startsWith('annual')) return 'year';
  return undefined;
}

export function salaryFromNumbers(
  min: unknown,
  max: unknown,
  currency: unknown,
  period: SalaryPeriod | undefined,
): Salary | undefined {
  const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : typeof v === 'string' && Number(v) > 0 ? Number(v) : undefined);
  const lo = n(min);
  const hi = n(max);
  if (lo == null && hi == null) return undefined;
  if (typeof currency !== 'string' || !currency) return undefined;
  return { min: lo, max: hi, currency: currency.toUpperCase(), period: period ?? 'year' };
}

interface JsonLdJob {
  title?: string;
  description?: string;
  hiringOrganization?: { name?: string } | string;
  jobLocationType?: string;
  baseSalary?: { currency?: string; value?: { minValue?: number; maxValue?: number; value?: number; unitText?: string } };
  jobLocation?: unknown;
}

function findJobPosting(node: unknown): JsonLdJob | undefined {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findJobPosting(n);
      if (f) return f;
    }
    return undefined;
  }
  const o = node as Record<string, unknown>;
  if (o['@type'] === 'JobPosting') return o as JsonLdJob;
  return findJobPosting(o['@graph']);
}

/**
 * Generic detail fetch: prefers schema.org JobPosting JSON-LD (most portals and ATSes ship it),
 * falls back to visible page text.
 */
export async function fetchDetailGeneric(url: string): Promise<Partial<RawJob>> {
  const html = await fetchText(url);
  const $ = cheerio.load(html);
  let posting: JsonLdJob | undefined;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (posting) return;
    try {
      posting = findJobPosting(JSON.parse($(el).text()));
    } catch {
      /* malformed JSON-LD */
    }
  });
  const out: Partial<RawJob> = {};
  if (posting) {
    out.description = htmlToText(posting.description);
    if (posting.title) out.title = clean(posting.title);
    const org = typeof posting.hiringOrganization === 'string' ? posting.hiringOrganization : posting.hiringOrganization?.name;
    if (org) out.company = clean(org);
    const place = jsonLdLocality(posting.jobLocation);
    if (place) out.location = place;
    if (posting.jobLocationType === 'TELECOMMUTE') out.workMode = 'remote';
    const v = posting.baseSalary?.value;
    if (v && posting.baseSalary?.currency) {
      const unit = (v.unitText ?? '').toLowerCase();
      const period: SalaryPeriod =
        unit === 'hour' ? 'hour' : unit === 'day' ? 'day' : unit === 'month' ? 'month' : 'year';
      out.salary = salaryFromNumbers(v.minValue ?? v.value, v.maxValue ?? v.value, posting.baseSalary.currency, period);
    }
  }
  if (!out.description) {
    $('script,style,noscript,nav,header,footer,form,svg,iframe').remove();
    const main = $('main').length ? $('main') : $('article').length ? $('article') : $('body');
    out.description = htmlToText(main.html());
  }
  if (!out.salary && out.description) {
    // Look for a salary-looking line in the text
    const line = out.description
      .split('\n')
      .find((l) => /(kč|czk|eur|€|\$|usd)/i.test(l) && /\d{2}/.test(l) && /(plat|mzda|salary|odměn|compensation|rate|sazba|\d\s?000)/i.test(l));
    if (line && line.length < 200) {
      const s = parseSalary(line);
      if (s) {
        out.salary = s;
        out.salaryText = clean(line);
      }
    }
  }
  return out;
}

/** schema.org jobLocation (object or array) -> "Brno, Praha" */
function jsonLdLocality(loc: unknown): string | undefined {
  const list = Array.isArray(loc) ? loc : loc ? [loc] : [];
  const names = list
    .map((l) => {
      const a = (l as { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: unknown } })?.address;
      const country = typeof a?.addressCountry === 'string' ? a.addressCountry : (a?.addressCountry as { name?: string })?.name;
      return clean(a?.addressLocality ?? a?.addressRegion ?? country);
    })
    .filter(Boolean);
  return names.length ? [...new Set(names)].slice(0, 4).join(', ') : undefined;
}

/** schema.org JobPosting → RawJob (used by listing pages that embed JSON-LD, e.g. Djinni). */
export function jobPostingToRaw(n: Record<string, any>, baseUrl: string): RawJob | undefined {
  const url = absUrl(typeof n.url === 'string' ? n.url : undefined, baseUrl);
  const title = clean(n.title);
  if (!title || url === baseUrl) return undefined;
  const id = typeof n.identifier === 'object' ? n.identifier?.value : n.identifier;
  const org = typeof n.hiringOrganization === 'string' ? n.hiringOrganization : n.hiringOrganization?.name;
  const applicant = ([] as any[])
    .concat(n.applicantLocationRequirements ?? [])
    .map((a) => a?.name ?? a?.address?.addressCountry)
    .filter((x) => typeof x === 'string');
  const place = jsonLdLocality(n.jobLocation);
  const remote = n.jobLocationType === 'TELECOMMUTE';
  const v = n.baseSalary?.value;
  const unit = String(v?.unitText ?? '').toLowerCase();
  return {
    sourceJobId: String(id ?? url),
    url,
    title,
    company: org ? clean(org) : undefined,
    location: remote ? `Remote${applicant.length ? ` · ${applicant.join(', ')}` : ''}${place ? ` · ${place}` : ''}` : place,
    workMode: remote ? 'remote' : undefined,
    salary:
      v && n.baseSalary?.currency
        ? salaryFromNumbers(v.minValue ?? v.value, v.maxValue ?? v.value, n.baseSalary.currency, unit === 'hour' ? 'hour' : unit === 'day' ? 'day' : unit === 'month' ? 'month' : 'year')
        : undefined,
    description: htmlToText(n.description),
    tags: [n.category, n.employmentType, n.industry].flat().filter((x) => typeof x === 'string'),
    postedAt: n.datePosted,
  };
}

export function modeFromText(text: string): WorkMode | undefined {
  if (/hybrid|částečně z domova|občasn\S* práce z domova|možnost\S*(?: \S+)? práce z domova/i.test(text)) return 'hybrid';
  if (/remote|z domova|z domu|home office|na dálku/i.test(text)) return 'remote';
  return undefined;
}
