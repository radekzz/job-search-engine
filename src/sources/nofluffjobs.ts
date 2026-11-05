import { fetchText, withParam } from '../http.ts';
import type { RawJob, SalaryPeriod } from '../types.ts';
import { clean, salaryFromNumbers } from './util.ts';

// NFJ is an Angular SSR app – listings are embedded in <script id="serverApp-state">.

interface NfjPosting {
  id: string;
  url: string;
  title: string;
  name: string;
  posted?: number;
  technology?: string;
  category?: string;
  seniority?: string[];
  regions?: string[];
  fullyRemote?: boolean;
  location?: { places?: { city?: string; country?: { name?: string } }[]; fullyRemote?: boolean };
  salary?: { from?: number; to?: number; currency?: string; period?: string; type?: string };
  tiles?: { values?: { value: string; type: string }[] };
}

function findPostings(node: unknown, depth = 0): NfjPosting[] | undefined {
  if (!node || typeof node !== 'object' || depth > 6) return undefined;
  const o = node as Record<string, unknown>;
  if (Array.isArray(o.postings)) return o.postings as NfjPosting[];
  for (const v of Object.values(o)) {
    const f = findPostings(v, depth + 1);
    if (f) return f;
  }
  return undefined;
}

const PERIOD: Record<string, SalaryPeriod> = { Hour: 'hour', Day: 'day', Month: 'month', Year: 'year' };

export async function listNoFluffJobs(url: string, maxPages: number): Promise<RawJob[]> {
  const lang = new URL(url).pathname.split('/')[1] || 'cz';
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchText(page === 1 ? url : withParam(url, 'page', page));
    const m = html.match(/<script id="serverApp-state"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('NFJ: nenalezen serverApp-state (změnila se struktura stránky?)');
    const postings = findPostings(JSON.parse(m[1])) ?? [];
    for (const p of postings) {
      if (p.seniority?.length && p.seniority.every((s) => /junior|trainee/i.test(s))) continue;
      const remote = p.fullyRemote || p.location?.fullyRemote;
      const cities = [...new Set((p.location?.places ?? []).map((pl) => pl.city).filter((c): c is string => !!c && c !== 'Remote'))];
      const regions = (p.regions ?? []).map((r) => r.toUpperCase());
      const location = remote
        ? `Remote${regions.length ? ` (${regions.join(', ')})` : ''}${cities.length ? ` · ${cities.slice(0, 3).join(', ')}` : ''}`
        : cities.join(', ');
      out.push({
        sourceJobId: p.id,
        url: `https://nofluffjobs.com/${lang}/job/${p.url}`,
        title: clean(p.title),
        company: p.name,
        location,
        workMode: remote ? 'remote' : cities.some((c) => /brno/i.test(c)) ? undefined : 'onsite',
        salary: p.salary
          ? salaryFromNumbers(p.salary.from, p.salary.to, p.salary.currency, PERIOD[p.salary.period ?? ''] ?? 'month')
          : undefined,
        salaryText: p.salary?.type ? `${p.salary.type.toUpperCase()}` : undefined,
        tags: [p.technology, p.category, ...(p.tiles?.values ?? []).map((t) => t.value), ...(p.seniority ?? [])].filter(
          (x): x is string => !!x,
        ),
        postedAt: p.posted ? new Date(p.posted).toISOString() : undefined,
      });
    }
    if (postings.length < 20) break;
  }
  return out;
}
