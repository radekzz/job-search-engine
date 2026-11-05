// JSON APIs of remote-first job boards.
import { fetchJson, withParam } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob } from '../types.ts';
import { clean, htmlToText, periodFrom, salaryFromNumbers } from './util.ts';

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);

// ---------------------------------------------------------------- remoteok.com
export async function listRemoteOk(url: string): Promise<RawJob[]> {
  const data = await fetchJson<Obj[]>(url);
  return data
    .filter((j) => j.id && j.position) // first element is a legal notice
    .map((j) => ({
      sourceJobId: str(j.id)!,
      url: str(j.url) ?? `https://remoteok.com/remote-jobs/${str(j.slug)}`,
      title: clean(str(j.position)),
      company: str(j.company),
      location: clean(str(j.location)) || 'Remote',
      workMode: 'remote' as const,
      salary: salaryFromNumbers(j.salary_min, j.salary_max, 'USD', 'year'),
      description: htmlToText(str(j.description)),
      tags: arr(j.tags),
      postedAt: str(j.date),
      applyUrl: str(j.apply_url),
    }));
}

// ---------------------------------------------------------------- remotive.com
export async function listRemotive(url: string): Promise<RawJob[]> {
  const data = await fetchJson<{ jobs: Obj[] }>(url);
  return data.jobs.map((j) => {
    const salaryText = clean(str(j.salary)) || undefined;
    return {
      sourceJobId: str(j.id)!,
      url: str(j.url)!,
      title: clean(str(j.title)),
      company: str(j.company_name),
      location: clean(str(j.candidate_required_location)) || 'Remote',
      workMode: 'remote' as const,
      salaryText,
      salary: parseSalary(salaryText, 'USD'),
      description: htmlToText(str(j.description)),
      tags: arr(j.tags),
      postedAt: str(j.publication_date),
    };
  });
}

// ---------------------------------------------------------------- himalayas.app
export async function listHimalayas(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchJson<{ jobs: Obj[] }>(page === 1 ? url : withParam(url, 'page', page));
    for (const j of data.jobs ?? []) {
      const restrictions = arr(j.locationRestrictions);
      out.push({
        sourceJobId: str(j.guid) ?? str(j.applicationLink)!,
        url: str(j.applicationLink) ?? str(j.guid)!,
        title: clean(str(j.title)),
        company: str(j.companyName),
        location: restrictions.length ? restrictions.join(', ') : 'Worldwide',
        workMode: 'remote',
        salary: salaryFromNumbers(j.minSalary, j.maxSalary, j.currency, periodFrom(str(j.salaryPeriod))),
        description: htmlToText(str(j.description)),
        tags: [...arr(j.categories), ...arr(j.seniority)],
        postedAt: typeof j.pubDate === 'number' ? new Date(j.pubDate * 1000).toISOString() : str(j.pubDate),
      });
    }
    if ((data.jobs ?? []).length < 20) break;
  }
  return out;
}

// ---------------------------------------------------------------- jobicy.com
export async function listJobicy(url: string): Promise<RawJob[]> {
  const data = await fetchJson<{ jobs?: Obj[] }>(url);
  return (data.jobs ?? []).map((j) => ({
    sourceJobId: str(j.id)!,
    url: str(j.url)!,
    title: clean(str(j.jobTitle)),
    company: str(j.companyName),
    location: clean(str(j.jobGeo)) || 'Remote',
    workMode: 'remote' as const,
    salary: salaryFromNumbers(
      j.salaryMin ?? j.annualSalaryMin,
      j.salaryMax ?? j.annualSalaryMax,
      j.salaryCurrency,
      periodFrom(str(j.salaryPeriod)) ?? 'year',
    ),
    description: htmlToText(str(j.jobDescription) ?? str(j.jobExcerpt)),
    tags: [...arr(j.jobIndustry), ...arr(j.jobType), str(j.jobLevel)].filter((x): x is string => !!x),
    postedAt: str(j.pubDate),
  }));
}

// ---------------------------------------------------------------- arbeitnow.com
export async function listArbeitnow(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = await fetchJson<{ data: Obj[] }>(page === 1 ? url : withParam(url, 'page', page));
    for (const j of data.data ?? []) {
      out.push({
        sourceJobId: str(j.slug)!,
        url: str(j.url)!,
        title: clean(str(j.title)),
        company: str(j.company_name),
        location: j.remote ? `Remote (${clean(str(j.location))})` : clean(str(j.location)),
        workMode: j.remote ? 'remote' : undefined,
        description: htmlToText(str(j.description)),
        tags: [...arr(j.tags), ...arr(j.job_types)],
        postedAt: typeof j.created_at === 'number' ? new Date(j.created_at * 1000).toISOString() : undefined,
      });
    }
    if (!data.data?.length) break;
  }
  return out;
}
