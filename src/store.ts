import { dataPath, readJson, writeJsonAtomic } from './fsutil.ts';
import { evaluate, isRelevant } from './filters.ts';
import { computeMatch } from './match.ts';
import { formatSalary } from './salary.ts';
import type { AppConfig, Enrichment, Job, JobStatus, RawJob, SourceConfig, Verdict } from './types.ts';

const JOBS_FILE = dataPath('jobs.json');
const MAX_CHANGES = 20;

let jobs = new Map<string, Job>(readJson<Job[]>(JOBS_FILE, []).map((j) => [j.id, j]));
let saveTimer: NodeJS.Timeout | null = null;

export function allJobs(): Job[] {
  return [...jobs.values()];
}

/** Jobs shown to the user (without merged/irrelevant tombstones). */
export function visibleJobs(): Job[] {
  return allJobs().filter((j) => !j.hidden);
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/** Persist now (used at the end of each source + on shutdown). */
export function flush(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeJsonAtomic(JOBS_FILE, allJobs());
}

/** Coalesce frequent writes (e.g. status clicks) into one disk write. */
export function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 300);
}

/** Same offer on different portals → same key. */
const LOCATION_SEGMENT =
  /\b(remote|hybrid|onsite|on-site|office|brno|praha|prague|czech|czechia|cz|europe|emea|eu|worldwide|anywhere|global|poland|germany|berlin|london|uk|usa?|portugal|spain|lisbon|barcelona|amsterdam|warsaw|krakow|vienna)\b/;
const COMPANY_NOISE = /\b(s\s?r\s?o|a\s?s|spol|gmbh|ag|se|inc|ltd|llc|plc|bv|sa|sas|oy|ab|group|technologies|technology|tech|labs|software|digital|the|cz|czech|europe|global|holding)\b/g;

const fold = (s = '') =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

export function normTitle(title = ''): string {
  let t = fold(title)
    .replace(/\(?\b[mfwdxzž]\s?\/\s?[mfwdxzž](\s?\/\s?[mfwdxzž])?\b\)?/g, ' ') // (m/f/d), m/w/d, (m/ž)
    .replace(/\((all genders|any gender)\)/g, ' ')
    .replace(/\bsr\.?\s/g, 'senior ')
    .replace(/\bjr\.?\s/g, 'junior ');
  // drop trailing " - Remote", " | Brno", " (Prague, hybrid)" style qualifiers
  const parts = t.split(/\s[-–—|]\s|\s\/\s/);
  while (parts.length > 1 && LOCATION_SEGMENT.test(parts[parts.length - 1])) parts.pop();
  t = parts.join(' ').replace(/\(([^)]*)\)/g, (m, inner) => (LOCATION_SEGMENT.test(inner) ? ' ' : ` ${inner} `));
  return t
    .replace(/\b(100\s?%|fully|full|remote|hybrid|onsite|on-site)\b/g, ' ')
    .replace(/[^a-z0-9#+]+/g, ' ')
    .trim();
}

/** Whole company name without legal forms / noise words and spaces: "Rohlik Group" → "rohlik", "Kiwi.com s.r.o." → "kiwicom". */
export function normCompany(company = ''): string {
  return fold(company).replace(/[^a-z0-9]+/g, ' ').replace(COMPANY_NOISE, ' ').replace(/\s+/g, '');
}

export function dupKey(raw: Pick<RawJob, 'title' | 'company'>): string {
  return `${normTitle(raw.title)}|${normCompany(raw.company)}`;
}

/**
 * Same offer? Titles must match exactly; companies exactly or as a prefix of ≥ 5 chars
 * ("jobscontact" ≈ "jobscontactpersonal", but "cez" ≠ "cezdistribuce"). No company → never a duplicate.
 */
export function sameOffer(a: string, b: string): boolean {
  const [ta, ca = ''] = a.split('|');
  const [tb, cb = ''] = b.split('|');
  if (!ta || ta !== tb || !ca || !cb) return false;
  if (ca === cb) return true;
  const [short, long] = ca.length < cb.length ? [ca, cb] : [cb, ca];
  return short.length >= 5 && long.startsWith(short);
}

/**
 * One-off pass over stored jobs: recompute keys with the current normalisation and fold
 * untouched duplicates into the best card (user-marked > earliest seen). Marked jobs are never hidden.
 */
export function dedupeAll(): number {
  let changed = 0;
  // 1) re-validate existing merges with the current normalisation – undo the ones that no longer match
  for (const j of jobs.values()) {
    if (j.hidden !== 'merged') continue;
    const primary = j.mergedInto ? jobs.get(j.mergedInto) : undefined;
    if (!primary || !sameOffer(dupKey(j), dupKey(primary))) {
      j.hidden = undefined;
      j.mergedInto = undefined;
      if (primary) primary.links = primary.links.filter((l) => l.url !== j.url);
      changed++;
    }
  }
  // 2) group visible jobs by title, then by matching company
  const byTitle = new Map<string, Job[]>();
  for (const j of jobs.values()) {
    if (j.hidden || (j.provisional && !j.detailFetched)) continue;
    j.dupKey = dupKey(j);
    if (!j.dupKey.split('|')[1]) continue; // no company → can't dedup safely
    const t = j.dupKey.split('|')[0];
    byTitle.set(t, [...(byTitle.get(t) ?? []), j]);
  }
  // user-marked first; a rejected card absorbs new copies of the *same* offer (stays rejected)
  const weight = (j: Job) => ({ applied: 0, watch: 1, rejected: 2, new: 3 })[j.status];
  const groups: Job[][] = [];
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    const local: Job[][] = []; // groups within one title only – keeps this ~O(n)
    for (const j of list) {
      const g = local.find((x) => sameOffer(x[0].dupKey, j.dupKey));
      if (g) g.push(j);
      else local.push([j]);
    }
    groups.push(...local);
  }
  for (const g of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => weight(a) - weight(b) || a.firstSeenAt.localeCompare(b.firstSeenAt));
    const [primary, ...rest] = g;
    for (const d of rest) {
      for (const l of [{ sourceId: d.sourceId, sourceName: d.sourceName, url: d.url }, ...d.links]) {
        if (l.sourceId !== primary.sourceId && !primary.links.some((x) => x.sourceId === l.sourceId)) primary.links.push(l);
      }
      if (d.status === 'new') {
        d.hidden = 'merged';
        d.mergedInto = primary.id;
        changed++;
      }
    }
  }
  if (changed) flush();
  return changed;
}

const RANK: Record<Verdict, number> = { fail: 0, unclear: 1, ok: 2 };

/**
 * Some boards list one offer per country (Himalayas) and portals differ in detail –
 * never let a variant downgrade an acceptable location to a worse one.
 */
function locationNotWorse(job: Job, raw: RawJob, cfg: AppConfig): boolean {
  const cand = evaluate({ ...job, location: raw.location, workMode: raw.workMode ?? job.workMode }, cfg).location;
  return RANK[cand] >= RANK[job.evaluation.location];
}

const salaryLabel = (j: RawJob) => (j.salary ? formatSalary(j.salary) : j.salaryText);

export interface UpsertResult {
  job: Job;
  isNew: boolean;
}

export function upsert(raw: RawJob, source: SourceConfig, cfg: AppConfig): UpsertResult {
  const now = new Date().toISOString();
  const id = `${source.id}:${raw.sourceJobId}`;
  let existing = jobs.get(id);
  const key = dupKey(raw);

  if (existing?.hidden) {
    existing.lastSeenAt = now;
    const primary = existing.mergedInto ? jobs.get(existing.mergedInto) : undefined;
    if (primary) {
      primary.lastSeenAt = now;
      primary.gone = false;
      return { job: primary, isNew: false };
    }
    if (existing.hidden === 'irrelevant') return { job: existing, isNew: false };
    // primary was removed (e.g. its source deleted) → show this one again
    existing.hidden = undefined;
    existing.mergedInto = undefined;
  }

  if (!existing && raw.company) {
    // Duplicate (other portal, or per-country variant on the same one): merge into the job we have.
    const dup = allJobs().find((j) => !j.hidden && sameOffer(j.dupKey, key));
    if (dup) {
      if (dup.sourceId !== source.id && !dup.links.some((l) => l.sourceId === source.id)) {
        dup.links.push({ sourceId: source.id, sourceName: source.name, url: raw.url });
      }
      dup.lastSeenAt = now;
      dup.gone = false;
      // Fill gaps (e.g. salary only shown on one portal) / take a better location variant
      let changed = false;
      if (!dup.salary && raw.salary) {
        dup.salary = raw.salary;
        dup.salaryText = raw.salaryText;
        changed = true;
      }
      if (raw.location && raw.location !== dup.location) {
        const cand = evaluate({ ...dup, location: raw.location, workMode: raw.workMode ?? dup.workMode }, cfg).location;
        if (RANK[cand] > RANK[dup.evaluation.location]) {
          dup.location = raw.location;
          dup.workMode = raw.workMode ?? dup.workMode;
          changed = true;
        }
      }
      if (changed) refresh(dup, cfg);
      return { job: dup, isNew: false };
    }
  }

  if (existing) {
    // Track meaningful changes
    const track = (field: string, from?: string, to?: string) => {
      if (raw.provisional) return; // placeholder values (slug title) are not real changes
      if ((from ?? '') !== (to ?? '') && to) existing!.changes.unshift({ at: now, field, from, to });
    };
    track('title', existing.title, raw.title);
    if (raw.salary) track('salary', salaryLabel(existing), salaryLabel(raw));
    const takeLocation = !raw.provisional && raw.location !== undefined && locationNotWorse(existing, raw, cfg);
    if (takeLocation) track('location', existing.location, raw.location);
    existing.changes = existing.changes.slice(0, MAX_CHANGES);
    const wasGone = existing.gone;
    Object.assign(existing, {
      title: raw.provisional && existing.detailFetched ? existing.title : raw.title || existing.title,
      url: raw.url || existing.url,
      company: raw.provisional ? existing.company : (raw.company ?? existing.company),
      location: takeLocation ? raw.location : existing.location,
      salary: raw.salary ?? existing.salary,
      salaryText: raw.salaryText ?? existing.salaryText,
      workMode: raw.workMode ?? existing.workMode,
      tags: raw.tags?.length ? raw.tags : existing.tags,
      // Keep a fetched detail description unless the list itself carries one
      description: raw.description || existing.description,
      postedAt: raw.postedAt ?? existing.postedAt,
      applyUrl: raw.applyUrl ?? existing.applyUrl,
      lastSeenAt: now,
      gone: false,
      sourceName: source.name,
      dupKey: raw.provisional && existing.detailFetched ? existing.dupKey : key,
    });
    if (wasGone) existing.changes.unshift({ at: now, field: 'reappeared', to: 'znovu v nabídce' });
    refresh(existing, cfg);
    return { job: existing, isNew: false };
  }

  const job: Job = {
    ...raw,
    id,
    sourceId: source.id,
    sourceName: source.name,
    dupKey: key,
    links: [],
    firstSeenAt: now,
    lastSeenAt: now,
    gone: false,
    status: 'new',
    evaluation: evaluate(raw, cfg),
    match: computeMatch(raw, cfg.profile),
    changes: [],
  };
  jobs.set(id, job);
  return { job, isNew: true };
}

export function applyDetail(job: Job, detail: Partial<RawJob>, cfg: AppConfig): void {
  if (detail.description) job.description = detail.description;
  // Provisional listings (slug titles) get their real identity from the detail
  if (job.provisional && !job.detailFetched) {
    if (detail.title) job.title = detail.title;
    if (detail.company) job.company = detail.company;
    if (detail.location) job.location = detail.location;
    job.dupKey = dupKey(job);
    // The slug passed the role filter, but the real (diacritics-aware) title may not.
    // Never hide a card the user already acted on.
    const untouched = job.status === 'new';
    if (!isRelevant(job, cfg)) {
      if (untouched) job.hidden = 'irrelevant';
    } else if (job.company) {
      // Same offer already known from another portal → link it on that card,
      // and (if the user hasn't acted on this one) hide this duplicate.
      const dup = allJobs().find((j) => j.id !== job.id && !j.hidden && sameOffer(j.dupKey, job.dupKey));
      if (dup) {
        if (!dup.links.some((l) => l.sourceId === job.sourceId)) dup.links.push({ sourceId: job.sourceId, sourceName: job.sourceName, url: job.url });
        if (untouched) {
          job.hidden = 'merged';
          job.mergedInto = dup.id;
        }
      }
    }
  }
  if (!job.salary && detail.salary) {
    job.salary = detail.salary;
    job.salaryText = detail.salaryText ?? job.salaryText;
  }
  if ((!job.workMode || job.workMode === 'unknown') && detail.workMode) job.workMode = detail.workMode;
  if (detail.tags?.length) job.tags = [...new Set([...(job.tags ?? []), ...detail.tags])];
  job.detailFetched = true;
  job.detailAttempts = (job.detailAttempts ?? 0) + 1;
  refresh(job, cfg);
}

export function refresh(job: Job, cfg: AppConfig): void {
  job.evaluation = evaluate(job, cfg);
  job.match = computeMatch(job, cfg.profile);
}

/** Re-run filters + stack match for everything (after profile/filter edits). */
export function reevaluateAll(cfg: AppConfig): void {
  for (const j of jobs.values()) {
    // filters may have changed – an "irrelevant" tombstone can become relevant again
    if (j.hidden === 'irrelevant' && isRelevant(j, cfg)) j.hidden = undefined;
    refresh(j, cfg);
  }
  flush();
}

/** Jobs of a successfully scanned source that weren't seen for a while are marked gone. */
export function markGone(sourceId: string, cfg: AppConfig): void {
  const cutoff = Date.now() - cfg.settings.goneAfterHours * 3600_000;
  for (const j of jobs.values()) {
    if (j.sourceId === sourceId && !j.hidden && !j.gone && Date.parse(j.lastSeenAt) < cutoff) {
      j.gone = true;
      j.changes.unshift({ at: new Date().toISOString(), field: 'gone', to: 'už není v nabídce' });
    }
  }
}

export function setEnrichment(id: string, e: Enrichment): Job | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  j.enrichment = e;
  scheduleSave();
  return j;
}

export function setStatus(id: string, status: JobStatus, note?: string): Job | undefined {
  const j = jobs.get(id);
  if (!j) return undefined;
  if (j.status !== status) {
    j.status = status;
    j.statusChangedAt = new Date().toISOString();
  }
  if (note !== undefined) j.note = note.slice(0, 2000);
  scheduleSave();
  return j;
}

export function removeSourceJobs(sourceId: string): void {
  // Keep jobs the user already acted on; drop untouched ones.
  jobs = new Map([...jobs].filter(([, j]) => j.sourceId !== sourceId || j.status !== 'new'));
  flush();
}
