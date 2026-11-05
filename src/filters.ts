import { formatSalary, toCzkMonth } from './salary.ts';
import { jobText, patternFor } from './match.ts';
import type { AppConfig, Evaluation, Filters, Profile, RawJob, Verdict, WorkMode } from './types.ts';

const reCache = new Map<string, RegExp | null>();
function re(src: string): RegExp | null {
  if (!reCache.has(src)) {
    try {
      reCache.set(src, new RegExp(src, 'i'));
    } catch {
      reCache.set(src, null); // invalid user regex – ignored
    }
  }
  return reCache.get(src)!;
}
const anyMatch = (patterns: string[], text: string) => patterns.find((p) => re(p)?.test(text));

const REMOTE_RE = /remote|remotely|home[- ]?office|z domova|na dálku|vzdálen|work from home|\bwfh\b|anywhere|distributed|telecommute|práca z domu/i;
const HYBRID_RE = /hybrid|hybridn|částečně z domova|občasn\S* práce z domova|možnost\S*(?: \S+)? práce z domova|kombinovan|partially remote|\d+ days? (?:in|at) (?:the )?office/i;
const FULL_REMOTE_RE = /full[ -]?remote|fully remote|100\s?% remote|remote[- ]first|plně (?:z domova|vzdálen)|převážně z domova|remote only/i;

// Region restriction written into the title, e.g. "React Dev - Latin America, Remote", "(US only)"
const TITLE_REGION_BLOCK =
  /(?<![a-z])(?:latam|latin america|south america|north america|americas|us[- ]based|u\.s\.? based|us only|usa|\(us\)|canada|india|apac|brazil|mexico|philippines)(?![a-z])/i;

// Description says the role is open EU/Europe-wide (upgrades "remote, but listed in another country").
const EU_WIDE_RE =
  /(?:anywhere|any country|remote(?:ly)?|work from|based) (?:in|within|across|from) (?:the )?(?:eu\b|europe|emea|european union|cet)|(?:eu|europe|emea)[- ](?:wide|based|remote)|remote[^.\n]{0,30}\b(?:eu|europe|emea)\b|european time ?zones?|cet (?:time ?zone|±|\+\/-)/i;

/** Core-skill presence – used to accept generic titles like "Software Engineer". */
function mentionsCore(text: string, profile: Profile, hints: string[]): boolean {
  // dictionary patterns / word boundaries – "java" must not match "javascript"
  return profile.core.some((c) => patternFor(c).test(text)) || anyMatch(hints.map((h) => `\\b${h}\\b`), text) !== undefined;
}

/** Cheap pre-filter on title/tags – decides if a listing is worth storing at all. */
export function isRelevant(job: RawJob, cfg: AppConfig): boolean {
  const title = job.title.toLowerCase();
  const f = cfg.filters;
  if (anyMatch(f.titleExclude, title)) return false;
  if (anyMatch(f.titleInclude, title)) return true;
  if (anyMatch(f.titleGeneric, title)) return mentionsCore(jobText(job), cfg.profile, f.titleGenericHints ?? []);
  return false;
}

export function detectWorkMode(job: RawJob): WorkMode {
  if (job.workMode && job.workMode !== 'unknown') return job.workMode;
  const head = `${job.title} ${job.location ?? ''} ${(job.tags ?? []).join(' ')}`;
  if (HYBRID_RE.test(head)) return 'hybrid';
  if (FULL_REMOTE_RE.test(head) || REMOTE_RE.test(head)) return 'remote';
  // "Worldwide"/"Global" mean remote only as a location – in a title it's often "Global Payments"
  if (/worldwide|\bglobal\b/i.test(job.location ?? '')) return 'remote';
  const desc = job.description ?? '';
  // Hybrid first: Czech benefits like "možnost občasné práce z domova" must not read as full remote
  if (HYBRID_RE.test(desc)) return 'hybrid';
  if (FULL_REMOTE_RE.test(desc)) return 'remote';
  return job.location ? 'onsite' : 'unknown';
}

function evaluateLocation(job: RawJob, mode: WorkMode, f: Filters): { verdict: Verdict; reason?: string } {
  const loc = (job.location ?? '').toLowerCase();
  const inCity = f.onsiteCities.some((c) => loc.includes(c.toLowerCase()));
  if (inCity) return { verdict: 'ok' };
  if (mode === 'remote') {
    // Remote: OK when the region is CZ/EU/worldwide, fail when explicitly elsewhere.
    const titleRegion = job.title.match(TITLE_REGION_BLOCK)?.[0];
    if (titleRegion) return { verdict: 'fail', reason: `remote jen pro region: ${titleRegion}` };
    const region = `${job.location ?? ''} ${(job.tags ?? []).join(' ')}`;
    if (!job.location || /^\s*(remote|anywhere|worldwide)\s*$/i.test(job.location)) {
      const desc = (job.description ?? '').slice(0, 2000);
      if (anyMatch(f.remoteBlocked, desc) && !anyMatch(f.remoteAllowed, desc))
        return { verdict: 'unclear', reason: 'remote – popis zmiňuje jiný region' };
      return { verdict: 'ok' };
    }
    if (anyMatch(f.remoteAllowed, region)) return { verdict: 'ok' };
    const blocked = anyMatch(f.remoteBlocked, region);
    if (blocked) return { verdict: 'fail', reason: `remote jen pro: ${job.location}` };
    if (EU_WIDE_RE.test(job.description ?? '')) return { verdict: 'ok' };
    return { verdict: 'unclear', reason: `remote v jiné zemi (${job.location}) – ověř, jestli jde z ČR` };
  }
  if (mode === 'unknown' && !loc) return { verdict: 'unclear', reason: 'lokalita neuvedena' };
  const czech = /česk|czech|praha|prague|ostrava|olomouc|plzeň|zlín|pardubic|hradec|liberec|jihlava|\bčr\b/i.test(loc);
  const cities = f.onsiteCities.join('/') || '—';
  if (czech && mode === 'hybrid') return { verdict: 'fail', reason: `hybrid mimo ${cities} (${job.location})` };
  if (mode === 'unknown') return { verdict: 'unclear', reason: `režim práce nejasný (${job.location})` };
  return { verdict: 'fail', reason: `${mode === 'hybrid' ? 'hybrid' : 'onsite'} mimo ${cities} (${job.location})` };
}

export function evaluate(job: RawJob, cfg: AppConfig): Evaluation {
  const f = cfg.filters;
  const reasons: string[] = [];
  const workMode = detectWorkMode(job);
  const loc = evaluateLocation(job, workMode, f);
  if (loc.reason) reasons.push(loc.reason);

  let salary: Evaluation['salary'] = 'unknown';
  const czk = job.salary ? toCzkMonth(job.salary) : undefined;
  if (czk && (czk.max ?? czk.min) != null) {
    const top = czk.max ?? czk.min!;
    salary = top >= f.minSalaryCzkMonth ? 'ok' : 'fail';
    if (salary === 'fail') reasons.push(`plat ${formatSalary(job.salary!)} ≈ ${top.toLocaleString('cs-CZ')} Kč/měs`);
  } else if (f.hideUnknownSalary) {
    reasons.push('plat neuveden');
  }

  let verdict: Verdict = 'ok';
  if (loc.verdict === 'fail' || salary === 'fail' || (salary === 'unknown' && f.hideUnknownSalary)) verdict = 'fail';
  else if (loc.verdict === 'unclear') verdict = 'unclear';
  return { verdict, reasons, workMode, location: loc.verdict, salary, salaryCzkMonth: czk };
}
