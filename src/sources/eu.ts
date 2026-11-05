// European / remote job boards: Djinni (generic JSON-LD), Remote Rocketship, remote.com, Arc.dev,
// Bulldogjob, EuroTechJobs, Landing.jobs, Working Nomads, Jooble (official API).
import * as cheerio from 'cheerio';
import { fetchJson, fetchText, withParam } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob } from '../types.ts';
import { absUrl, clean, htmlToText, jobPostingToRaw, modeFromText, salaryFromNumbers, stripQuery } from './util.ts';

type Obj = Record<string, any>; // external payloads – read defensively

const MONEY_RE = /(kč|czk|eur|€|\$|usd|£|gbp|pln|zł|chf)/i;

function nextData(html: string): Obj {
  const $ = cheerio.load(html);
  const raw = $('#__NEXT_DATA__').text();
  if (!raw) throw new Error('Chybí __NEXT_DATA__ (změnila se struktura stránky?)');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------- generic: JobPosting JSON-LD on a listing page (Djinni, …)
export async function listJsonLd(url: string, maxPages: number): Promise<RawJob[]> {
  const out = new Map<string, RawJob>();
  for (let page = 1; page <= maxPages; page++) {
    const $ = cheerio.load(await fetchText(page === 1 ? url : withParam(url, 'page', page)));
    let found = 0;
    $('script[type="application/ld+json"]').each((_, el) => {
      let data: unknown;
      try {
        data = JSON.parse($(el).text());
      } catch {
        return;
      }
      const nodes = ([] as Obj[]).concat(data as Obj).flatMap((n) => (n?.['@graph'] ? n['@graph'] : [n]));
      for (const n of nodes) {
        if (n?.['@type'] !== 'JobPosting') continue;
        const job = jobPostingToRaw(n, url);
        if (job && !out.has(job.sourceJobId)) {
          out.set(job.sourceJobId, job);
          found++;
        }
      }
    });
    if (!found) break;
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- remoterocketship.com (Next.js page data)
export async function listRemoteRocketship(url: string): Promise<RawJob[]> {
  const jobs: Obj[] = nextData(await fetchText(url)).props?.pageProps?.initialJobOpenings ?? [];
  return jobs
    .filter((j) => !j.dateDeleted && !j.isEntryLevel && !j.isJunior)
    .map((j) => {
      const sr = j.salaryRange;
      return {
        sourceJobId: String(j.id),
        url: j.company?.slug && j.slug ? `https://www.remoterocketship.com/company/${j.company.slug}/jobs/${j.slug}/` : j.url,
        title: clean(j.roleTitle),
        company: clean(j.company?.name),
        location: clean(j.location) || (j.locationType === 'remote' ? 'Remote' : undefined),
        workMode: j.locationType === 'remote' ? 'remote' : j.locationType === 'hybrid' ? 'hybrid' : j.locationType === 'onsite' ? 'onsite' : undefined,
        salary: sr ? salaryFromNumbers(sr.min, sr.max, sr.currency ?? 'USD', 'year') : undefined,
        description: [j.jobDescriptionSummary, j.roleDescription, j.roleRequirements].filter(Boolean).join('\n'),
        tags: [...(j.techStack ?? []), j.categorizedJobTitle, j.employmentType].filter(Boolean),
        applyUrl: typeof j.url === 'string' ? j.url : undefined,
        postedAt: j.created_at,
      };
    });
}

// ---------------------------------------------------------------- remote.com job board (styled-components markup → text segments)
export async function listRemoteCom(url: string): Promise<RawJob[]> {
  const $ = cheerio.load(await fetchText(url));
  const out = new Map<string, RawJob>();
  $('a[href^="/jobs/"]').each((_, a) => {
    const href = $(a).attr('href')!;
    const m = href.match(/^\/jobs\/([^/]+)\/[^/]+-([a-z0-9]{6,})$/);
    if (!m || out.has(m[2])) return;
    const title = clean($(a).text());
    if (!title) return;
    // climb to the card (first ancestor with more text than the title)
    let card = $(a).parent();
    for (let i = 0; i < 5 && clean(card.text()).length <= title.length + 5; i++) card = card.parent();
    const parts = card
      .find('*')
      .contents()
      .filter((_, n) => n.type === 'text')
      .map((_, n) => clean($(n).text()))
      .get()
      .filter((t) => t && t !== title);
    const salaryText = parts.find((p) => MONEY_RE.test(p) && /\d/.test(p));
    const location = parts.find((p) => /anywhere|worldwide|europe|emea|cet|united|germany|poland|czech|spain|portugal|france|uk\b|\bus\b|canada|latam/i.test(p));
    out.set(m[2], {
      sourceJobId: m[2],
      url: absUrl(href, url),
      title,
      company: parts[0] ?? m[1].replace(/-[a-z0-9]{6,}$/, '').replace(/-/g, ' '),
      location: parts.includes('Remote') ? `Remote · ${location ?? ''}`.replace(/ · $/, '') : location,
      workMode: parts.includes('Remote') ? 'remote' : modeFromText(parts.join(' ')),
      salaryText,
      salary: parseSalary(salaryText, 'USD'),
      tags: parts.filter((p) => /contract|full[- ]time|part[- ]time|freelance/i.test(p)),
    });
  });
  return [...out.values()];
}

// ---------------------------------------------------------------- arc.dev (Next.js page data)
export async function listArc(url: string): Promise<RawJob[]> {
  const jobs: Obj[] = nextData(await fetchText(url)).props?.pageProps?.arcJobs ?? [];
  return jobs.map((j) => {
    const hourly = j.minHourlyRate || j.maxHourlyRate;
    return {
      sourceJobId: j.randomKey,
      url: `https://arc.dev/remote-jobs/j/${j.urlString}-${j.randomKey}`,
      title: clean(j.title),
      company: clean(j.company?.name) || undefined,
      location: j.requiredCountries?.length ? `Remote · ${j.requiredCountries.join(', ')}` : 'Remote · Worldwide',
      workMode: 'remote' as const,
      salary: hourly
        ? salaryFromNumbers(j.minHourlyRate, j.maxHourlyRate, 'USD', 'hour')
        : salaryFromNumbers(j.minAnnualSalary, j.maxAnnualSalary, 'USD', 'year'),
      tags: [...(j.categories ?? []).map((c: Obj) => c.name), j.jobType, j.experienceLevel].filter(Boolean),
      postedAt: j.postedAt ? new Date(j.postedAt * 1000).toISOString() : undefined,
    };
  });
}

// ---------------------------------------------------------------- bulldogjob.pl (Next.js / Apollo page data)
function findArray(o: unknown, pred: (x: Obj) => boolean, depth = 0): Obj[] | undefined {
  if (!o || typeof o !== 'object' || depth > 8) return undefined;
  for (const v of Object.values(o)) {
    if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object' && pred(v[0])) return v;
    const f = findArray(v, pred, depth + 1);
    if (f) return f;
  }
  return undefined;
}

export async function listBulldog(url: string): Promise<RawJob[]> {
  const jobs = findArray(nextData(await fetchText(url)).props?.pageProps, (x) => x.__typename === 'Job' && !!x.position) ?? [];
  return jobs.map((j) => {
    const s = j.denominatedSalaryLong ?? {};
    const remote = (j.environment?.remotePossible ?? 0) >= 100 || j.remote === true;
    return {
      sourceJobId: j.id,
      url: `https://bulldogjob.pl/companies/jobs/${j.id}`,
      title: clean(j.position),
      company: clean(j.company?.name),
      location: remote ? `Remote${j.city ? ` · ${j.city}` : ''} (PL)` : clean(j.city) || undefined,
      workMode: remote ? ('remote' as const) : undefined,
      salary: s.money ? parseSalary(`${s.money} ${s.currency ?? 'PLN'}`, 'PLN') : undefined,
      salaryText: s.money ? `${s.money} ${s.currency ?? ''}`.trim() : undefined,
      tags: [j.experienceLevel, j.employmentType, ...(j.technologyTags ?? [])].filter(Boolean),
    };
  });
}

// ---------------------------------------------------------------- eurotechjobs.com
export async function listEuroTechJobs(url: string, maxPages: number): Promise<RawJob[]> {
  const out = new Map<string, RawJob>();
  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = page === 1 ? url : `${url.replace(/\/$/, '')}/page/${page}`;
    const $ = cheerio.load(await fetchText(pageUrl));
    const before = out.size;
    $('h3 a[href*="/job_display/"]').each((_, a) => {
      const href = $(a).attr('href')!;
      const id = href.match(/\/job_display\/(\d+)/)?.[1];
      if (!id || out.has(id)) return;
      const box = $(a).closest('h3').parent();
      const location = clean(box.find('.location').first().text());
      out.set(id, {
        sourceJobId: id,
        url: stripQuery(absUrl(href, url)),
        title: clean($(a).text()),
        company: clean(box.find('.companyName').first().text()) || undefined,
        location,
        workMode: modeFromText(`${$(a).text()} ${location}`),
      });
    });
    if (out.size === before) break;
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- landing.jobs (public API)
export async function listLandingJobs(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  const limit = Number(new URL(url).searchParams.get('limit') ?? 50);
  for (let page = 0; page < maxPages; page++) {
    const data = await fetchJson<Obj[]>(withParam(withParam(url, 'limit', limit), 'offset', page * limit));
    for (const j of data) {
      const locs = (j.locations ?? []).map((l: Obj) => [l.city, l.country_code].filter(Boolean).join(', ')).filter(Boolean);
      out.push({
        sourceJobId: String(j.id),
        url: j.url,
        title: clean(j.title),
        company: clean(j.company_name) || clean(String(j.url ?? '').split('/at/')[1]?.split('/')[0]?.replace(/-/g, ' ')),
        location: j.remote ? `Remote${locs.length ? ` · ${locs.join('; ')}` : ''}` : locs.join('; '),
        workMode: j.remote ? 'remote' : undefined,
        salary: salaryFromNumbers(j.gross_salary_low, j.gross_salary_high, j.currency_code, 'year'),
        description: htmlToText(`${j.role_description ?? ''}\n${j.main_requirements ?? ''}\n${j.nice_to_have ?? ''}`),
        tags: (j.tags ?? []).map(String),
        postedAt: j.published_at,
      });
    }
    if (data.length < limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- workingnomads.com (public API)
export async function listWorkingNomads(url: string): Promise<RawJob[]> {
  const data = await fetchJson<Obj[]>(url);
  return data.map((j) => ({
    sourceJobId: String(j.url).match(/\/go\/(\d+)/)?.[1] ?? j.url,
    url: j.url,
    title: clean(j.title),
    company: clean(j.company_name),
    location: clean(j.location) || 'Remote',
    workMode: 'remote' as const,
    description: htmlToText(j.description),
    tags: String(j.tags ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    postedAt: j.pub_date,
  }));
}

// ---------------------------------------------------------------- Jooble (official REST API, key from env)
// URL form in config: https://jooble.org/api/?keywords=react&location=Brno  (the key is NEVER stored in config)
export async function listJooble(url: string, maxPages: number): Promise<RawJob[]> {
  const key = process.env.JOOBLE_API_KEY;
  if (!key) throw new Error('Chybí JOOBLE_API_KEY – zaregistruj se na https://jooble.org/api/about a spusť `JOOBLE_API_KEY=… yarn start`');
  const params = new URL(url).searchParams;
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    let text: string;
    try {
      text = await fetchText(`https://jooble.org/api/${encodeURIComponent(key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ keywords: params.get('keywords') ?? 'react', location: params.get('location') ?? '', page: String(page) }),
      });
    } catch (err) {
      // never let the API key (part of the URL) leak into logs / dashboard
      throw new Error(`Jooble API: ${String((err as Error).message).replaceAll(key, '***').replaceAll(encodeURIComponent(key), '***')}`);
    }
    const data = JSON.parse(text) as { jobs?: Obj[] };
    for (const j of data.jobs ?? []) {
      const salaryText = clean(j.salary) || undefined;
      out.push({
        sourceJobId: String(j.id),
        url: j.link,
        title: clean(j.title),
        company: clean(j.company) || undefined,
        location: clean(j.location) || undefined,
        workMode: modeFromText(`${j.title} ${j.location} ${j.type ?? ''}`),
        salaryText,
        salary: parseSalary(salaryText),
        description: htmlToText(j.snippet),
        tags: [j.type, j.source].filter(Boolean),
        postedAt: j.updated,
      });
    }
    if ((data.jobs ?? []).length < 20) break;
  }
  return out;
}

// ---------------------------------------------------------------- frontendengineers.com
// Category pages only (/remote-react-jobs, /remote-frontend-jobs-europe, …): robots.txt disallows /api/
// and job details are paywalled, so we use just the public listing (title, company, location, tech tags).
export async function listFrontendEngineers(url: string): Promise<RawJob[]> {
  const $ = cheerio.load(await fetchText(url));
  const out = new Map<string, RawJob>();
  $('a[href^="/jobs/"]').each((_, a) => {
    const href = $(a).attr('href')!;
    const slug = href.split('/')[2];
    if (!slug || out.has(slug)) return;
    const title = clean($(a).find('h3').first().text());
    if (!title) return;
    const [company, place] = clean($(a).find('p').first().text()).split(' • ');
    const tags = $(a)
      .find('span.rounded-full')
      .map((_, e) => clean($(e).text()))
      .get();
    const location = !place || /^remote( job)?$/i.test(place) ? 'Remote' : place.replace(/\s*\(remote\)\s*/i, '');
    out.set(slug, {
      sourceJobId: slug,
      url: absUrl(href, url),
      title,
      company: company || undefined,
      location,
      workMode: 'remote', // the board lists 100 % remote positions only
      tags,
    });
  });
  return [...out.values()];
}
