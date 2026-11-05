// Public job-board APIs of applicant tracking systems (one URL = one company board).
// Source URLs may be the API URL or the public careers page – the board token is parsed from either.
import { fetchJson } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob, SalaryPeriod, WorkMode } from '../types.ts';
import { clean, htmlToText, periodFrom, salaryFromNumbers } from './util.ts';

type Obj = Record<string, any>; // external API payloads – validated field by field below

const pretty = (token: string) => token.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function tokenFrom(url: string, patterns: RegExp[]): string {
  for (const re of patterns) {
    const m = url.match(re);
    if (m?.[1]) return m[1];
  }
  throw new Error(`Z URL nejde poznat firmu/board: ${url}`);
}

function modeFrom(text: string, explicit?: string): WorkMode | undefined {
  const e = (explicit ?? '').toLowerCase();
  if (e.includes('remote')) return 'remote';
  if (e.includes('hybrid')) return 'hybrid';
  if (e === 'onsite' || e === 'on-site' || e === 'in office') return 'onsite';
  if (/hybrid/i.test(text)) return 'hybrid';
  if (/remote|anywhere/i.test(text)) return 'remote';
  return undefined;
}

// ---------------------------------------------------------------- Greenhouse
// https://boards-api.greenhouse.io/v1/boards/{token}/jobs  |  https://job-boards.greenhouse.io/{token}
const GH_TOKEN = [/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/, /(?:job-)?boards(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([^/?#&]+)/];
const ghNames = new Map<string, string>();

export async function listGreenhouse(url: string): Promise<RawJob[]> {
  const token = tokenFrom(url, GH_TOKEN);
  if (!ghNames.has(token)) {
    const board = await fetchJson<Obj>(`https://boards-api.greenhouse.io/v1/boards/${token}`).catch(() => ({}) as Obj);
    ghNames.set(token, clean(board.name) || pretty(token));
  }
  const data = await fetchJson<{ jobs: Obj[] }>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`);
  return (data.jobs ?? []).map((j) => {
    const location = clean(j.location?.name);
    return {
      sourceJobId: `${token}-${j.id}`,
      url: j.absolute_url,
      title: clean(j.title),
      company: ghNames.get(token),
      location,
      workMode: modeFrom(location),
      postedAt: j.updated_at,
    };
  });
}

export async function detailGreenhouse(job: RawJob): Promise<Partial<RawJob>> {
  const [token, id] = [job.sourceJobId.slice(0, job.sourceJobId.lastIndexOf('-')), job.sourceJobId.split('-').pop()];
  const d = await fetchJson<Obj>(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${id}`);
  const description = htmlToText(d.content); // content is entity-encoded HTML; htmlToText decodes it
  const payLine = description.split('\n').find((l) => /(€|\$|£|eur|usd|czk|pln)\s?\d|\d\s?(€|eur|usd|czk)/i.test(l) && /salary|pay|compensation|range|base/i.test(l));
  return { description, ...(payLine ? { salary: parseSalary(payLine), salaryText: clean(payLine).slice(0, 120) } : {}) };
}

// ---------------------------------------------------------------- Lever
// https://api.lever.co/v0/postings/{company}?mode=json  |  https://jobs.lever.co/{company}
const LEVER_TOKEN = [/api(?:\.eu)?\.lever\.co\/v0\/postings\/([^/?#]+)/, /jobs(?:\.eu)?\.lever\.co\/([^/?#]+)/];

export async function listLever(url: string): Promise<RawJob[]> {
  const token = tokenFrom(url, LEVER_TOKEN);
  const host = /\.eu\.lever\.co/.test(url) ? 'api.eu.lever.co' : 'api.lever.co';
  const data = await fetchJson<Obj[]>(`https://${host}/v0/postings/${token}?mode=json`);
  return data.map((j) => {
    const location = clean(j.categories?.allLocations?.join(', ') || j.categories?.location);
    const sr = j.salaryRange;
    const interval = String(sr?.interval ?? '').toLowerCase();
    const period: SalaryPeriod | undefined = interval.includes('hour') ? 'hour' : interval.includes('month') ? 'month' : sr ? 'year' : undefined;
    return {
      sourceJobId: j.id,
      url: j.hostedUrl,
      title: clean(j.text),
      company: pretty(token),
      location,
      workMode: modeFrom(location, j.workplaceType),
      salary: sr ? salaryFromNumbers(sr.min, sr.max, sr.currency, period) : undefined,
      description: [j.descriptionPlain, ...(j.lists ?? []).map((l: Obj) => `${l.text}\n${htmlToText(l.content)}`), j.additionalPlain]
        .filter(Boolean)
        .join('\n')
        .slice(0, 20_000),
      tags: [j.categories?.commitment, j.categories?.team].filter(Boolean),
      postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : undefined,
    };
  });
}

// ---------------------------------------------------------------- Ashby
// https://api.ashbyhq.com/posting-api/job-board/{name}  |  https://jobs.ashbyhq.com/{name}
const ASHBY_TOKEN = [/posting-api\/job-board\/([^/?#]+)/, /jobs\.ashbyhq\.com\/([^/?#]+)/];

export async function listAshby(url: string): Promise<RawJob[]> {
  const token = tokenFrom(url, ASHBY_TOKEN);
  const data = await fetchJson<{ jobs: Obj[] }>(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=true`);
  return (data.jobs ?? [])
    .filter((j) => j.isListed !== false)
    .map((j) => {
      const locs = [j.location, ...(j.secondaryLocations ?? []).map((s: Obj) => s.location)].filter(Boolean);
      const location = clean([...new Set(locs)].join(', '));
      const comp = (j.compensation?.summaryComponents ?? []).find((c: Obj) => c.compensationType === 'Salary');
      const period = periodFrom(String(comp?.interval ?? '').replace(/^1\s*/, '').toLowerCase());
      return {
        sourceJobId: j.id,
        url: j.jobUrl,
        title: clean(j.title),
        company: pretty(token),
        location,
        workMode: j.isRemote ? 'remote' : modeFrom(location, j.workplaceType),
        salary: comp ? salaryFromNumbers(comp.minValue, comp.maxValue, comp.currencyCode, period ?? 'year') : undefined,
        salaryText: j.compensation?.compensationTierSummary || undefined,
        description: clean(j.descriptionPlain) ? String(j.descriptionPlain).slice(0, 20_000) : undefined,
        tags: [j.department, j.team, j.employmentType].filter(Boolean),
        postedAt: j.publishedAt,
      };
    });
}

// ---------------------------------------------------------------- SmartRecruiters
// https://api.smartrecruiters.com/v1/companies/{id}/postings  |  https://jobs.smartrecruiters.com/{id}
const SR_TOKEN = [/api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)/, /(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)/];

export async function listSmartRecruiters(url: string, maxPages: number): Promise<RawJob[]> {
  const token = tokenFrom(url, SR_TOKEN);
  const out: RawJob[] = [];
  for (let page = 0; page < Math.max(maxPages, 1) * 2; page++) {
    const data = await fetchJson<{ content: Obj[]; totalFound: number }>(
      `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100&offset=${page * 100}`,
    );
    for (const j of data.content ?? []) {
      const l = j.location ?? {};
      const location = clean(l.fullLocation || [l.city, l.country?.toUpperCase()].filter(Boolean).join(', '));
      out.push({
        sourceJobId: j.id,
        url: `https://jobs.smartrecruiters.com/${token}/${j.id}`,
        title: clean(j.name),
        company: clean(j.company?.name) || pretty(token),
        location: l.remote ? `Remote · ${location}` : location,
        workMode: l.remote ? 'remote' : l.hybrid ? 'hybrid' : undefined,
        tags: [j.typeOfEmployment?.label, j.department?.label].filter(Boolean),
        postedAt: j.releasedDate,
      });
    }
    if ((page + 1) * 100 >= (data.totalFound ?? 0)) break;
  }
  return out;
}

export async function detailSmartRecruiters(job: RawJob): Promise<Partial<RawJob>> {
  const token = job.url.split('/')[3];
  const d = await fetchJson<Obj>(`https://api.smartrecruiters.com/v1/companies/${token}/postings/${job.sourceJobId}`);
  const s = d.jobAd?.sections ?? {};
  return {
    description: [s.jobDescription?.text, s.qualifications?.text, s.additionalInformation?.text].map((t) => htmlToText(t)).join('\n').slice(0, 20_000),
  };
}

// ---------------------------------------------------------------- Recruitee
// https://{company}.recruitee.com/api/offers/  |  https://{company}.recruitee.com/
export async function listRecruitee(url: string): Promise<RawJob[]> {
  const token = tokenFrom(url, [/https?:\/\/([^.]+)\.recruitee\.com/]);
  const data = await fetchJson<{ offers: Obj[] }>(`https://${token}.recruitee.com/api/offers/`);
  return (data.offers ?? []).map((j) => {
    const location = clean(j.location || [j.city, j.country].filter(Boolean).join(', '));
    const sal = j.salary;
    return {
      sourceJobId: String(j.id),
      url: j.careers_url,
      title: clean(j.title),
      company: clean(j.company_name) || pretty(token),
      location: j.remote ? `Remote · ${location}` : location,
      workMode: j.remote ? 'remote' : j.hybrid ? 'hybrid' : modeFrom(location),
      salary: sal ? salaryFromNumbers(sal.min, sal.max, sal.currency, periodFrom(sal.period) ?? 'month') : undefined,
      description: htmlToText(`${j.description ?? ''}\n${j.requirements ?? ''}`),
      tags: [j.employment_type_code, j.department].filter(Boolean),
      postedAt: j.published_at,
    };
  });
}
