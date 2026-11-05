import { execFile } from 'node:child_process';
import { getConfig, saveConfig } from './config.ts';
import { isRelevant } from './filters.ts';
import { dataPath, readJson, writeJsonAtomic } from './fsutil.ts';
import { HttpError } from './http.ts';
import { refreshRates } from './salary.ts';
import { msg, timeLocale } from './i18n.ts';
import { ADAPTERS } from './sources/index.ts';
import { enrichJob } from './enrich.ts';
import { applyDetail, flush, markGone, setEnrichment, upsert, visibleJobs } from './store.ts';
import type { Job, ScanState, SourceConfig, SourceRunStatus } from './types.ts';

const STATE_FILE = dataPath('scan-state.json');
export const state: ScanState = readJson<ScanState>(STATE_FILE, { running: false, sources: {} });
state.running = false;

type Listener = (event: string, payload?: unknown) => void;
const listeners = new Set<Listener>();
export const onScanEvent = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const emit = (event: string, payload?: unknown) => listeners.forEach((l) => l(event, payload));

const log = (...args: unknown[]) => console.log(`[${new Date().toLocaleTimeString(timeLocale())}]`, ...args);

async function scanSource(source: SourceConfig, detailBudget: { left: number }): Promise<{ status: SourceRunStatus; fresh: Job[] }> {
  const cfg = getConfig();
  const adapter = ADAPTERS[source.type];
  const status: SourceRunStatus = {
    sourceId: source.id,
    startedAt: new Date().toISOString(),
    ok: true,
    fetched: 0,
    relevant: 0,
    newJobs: 0,
    errors: [],
  };
  state.sources[source.id] = status;
  emit('source', status);
  const fresh: Job[] = [];
  const needDetail: Job[] = [];
  const seen = new Set<string>();
  let urlFailures = 0;

  for (const url of source.urls) {
    try {
      const list = await adapter.list(url, source);
      status.fetched += list.length;
      for (const raw of list) {
        if (!raw.sourceJobId || !raw.title || seen.has(raw.sourceJobId)) continue;
        seen.add(raw.sourceJobId);
        if (!isRelevant(raw, cfg)) continue;
        status.relevant++;
        const { job, isNew } = upsert(raw, source, cfg);
        if (isNew) {
          status.newJobs++;
          fresh.push(job);
        }
        // skip the detail when the listing already carried a description (RSS/APIs) – saves requests, avoids 403s
        const hasDesc = adapter.hasDescription && (job.description?.length ?? 0) > 200;
        if (adapter.detail && !job.detailFetched && !hasDesc && !job.hidden && job.sourceId === source.id) needDetail.push(job);
      }
    } catch (err) {
      urlFailures++;
      status.errors.push(`${shortUrl(url)}: ${(err as Error).message}`);
      log(`✗ ${source.name}: ${(err as Error).message}`);
    }
  }
  flush(); // persist list results before the slower detail phase

  // Descriptions are needed for an accurate stack match & remote/salary detection.
  // Order: provisional (slug-only, barely usable without detail) → passing → filtered out
  // (filtered-out ones still get a detail eventually – e.g. "Worldwide" listed without a remote flag).
  const rank = (j: Job) => (j.provisional ? 0 : j.evaluation.verdict === 'fail' ? 2 : 1);
  needDetail.sort((a, b) => rank(a) - rank(b));
  for (const job of needDetail) {
    if (detailBudget.left <= 0) break;
    detailBudget.left--;
    try {
      applyDetail(job, await adapter.detail!(job), cfg);
    } catch (err) {
      // Permanent 4xx (except 429) or 3 failed attempts → stop retrying; transient errors retry next scan
      job.detailAttempts = (job.detailAttempts ?? 0) + 1;
      const permanent = err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 429;
      if (permanent || job.detailAttempts >= 3) job.detailFetched = true;
      status.errors.push(`detail ${shortUrl(job.url)}: ${(err as Error).message}`);
    }
  }

  status.ok = urlFailures < source.urls.length;
  // Only trust "missing" when every URL loaded and returned something (0 results = likely broken selectors)
  if (urlFailures === 0 && status.fetched > 0) markGone(source.id, cfg);
  status.finishedAt = new Date().toISOString();
  flush();
  log(msg('sourceDone', source.name, status.fetched, status.relevant, status.newJobs, status.errors.length));
  emit('source', status);
  return { status, fresh };
}

const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}${x.search}`.slice(0, 90);
  } catch {
    return u.slice(0, 90);
  }
};

let currentScan: Promise<void> | null = null;
let currentIsFull = false;

export function runScan(onlySourceId?: string): Promise<void> {
  if (currentScan) {
    // A full scan requested during a single-source scan must still happen afterwards.
    if (!onlySourceId && !currentIsFull) return currentScan.then(() => runScan());
    return currentScan;
  }
  currentIsFull = !onlySourceId;
  currentScan = (async () => {
    const cfg = getConfig();
    state.running = true;
    state.lastScanStartedAt = new Date().toISOString();
    emit('scan-start');
    log(onlySourceId ? msg('scanOne', onlySourceId) : msg('scanAll'));
    await refreshRates();
    const sources = cfg.sources.filter((s) => (onlySourceId ? s.id === onlySourceId : s.enabled));
    const detailBudget = { left: cfg.settings.maxDetailFetchesPerScan };
    // Different hosts in parallel; same-host requests are serialized by http.ts throttling.
    const results = await Promise.allSettled(sources.map((s) => scanSource(s, detailBudget)));
    const fresh = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.fresh : []));
    state.running = false;
    state.lastScanFinishedAt = new Date().toISOString();
    writeJsonAtomic(STATE_FILE, state);
    // Only what the dashboard shows by default (verdict ok) – "unclear" ones are hidden behind a checkbox.
    const good = fresh.filter((j) => !j.hidden && j.evaluation.verdict === 'ok' && j.status === 'new');
    // First ever scan: everything is new. Set the "seen" baseline so later scans' jobs get the NOVÉ badge.
    // re-read: the user may have edited profile/filters/sources during the scan – don't save a stale snapshot
    const cur = getConfig();
    if (!onlySourceId && !cur.lastAcknowledgedAt) saveConfig({ ...cur, lastAcknowledgedAt: state.lastScanFinishedAt });
    log(msg('scanDone', good.length));
    if (good.length && cfg.settings.notifications) notify(good);
    emit('scan-end', { newMatches: good.length });
  })().finally(() => {
    currentScan = null;
    state.running = false;
  });
  // Enrichment runs outside the scan lock: a manual scan can start meanwhile, "scan-end" isn't delayed.
  if (!onlySourceId) void currentScan.then(() => enrichBatch(getConfig().settings.maxEnrichPerScan)).catch((e) => log(msg('enrichFailed'), e));
  return currentScan;
}

const ENRICH_TTL_MS = 14 * 24 * 3600_000;
const inFlight = new Set<string>();

/** Look up the employer's original posting + published contacts, best candidates first. */
let enrichRunning = false;

async function enrichBatch(limit: number): Promise<void> {
  if (limit <= 0 || enrichRunning) return;
  enrichRunning = true;
  try {
    await enrichQueue(limit);
  } finally {
    enrichRunning = false;
  }
}

async function enrichQueue(limit: number): Promise<void> {
  const prio = (j: Job) => (j.status === 'watch' ? 0 : j.status === 'applied' ? 1 : 2);
  const queue = visibleJobs()
    .filter((j) => j.status !== 'rejected' && j.evaluation.verdict !== 'fail' && !inFlight.has(j.id))
    .filter((j) => !j.enrichment || Date.now() - Date.parse(j.enrichment.at) > ENRICH_TTL_MS)
    .sort((a, b) => prio(a) - prio(b) || (b.match.score ?? -1) - (a.match.score ?? -1))
    .slice(0, limit);
  if (!queue.length) return;
  log(msg('enrichStart', queue.length));
  let found = 0;
  // small concurrency – different employers are different hosts, http.ts keeps per-host gaps
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      const e = await runEnrich(j);
      if (e.status === 'found-original') found++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  flush();
  log(msg('enrichDone', found));
  emit('enriched');
}

export async function runEnrich(job: Job) {
  inFlight.add(job.id);
  try {
    const e = await enrichJob(job).catch(
      (err) => ({ at: new Date().toISOString(), status: 'error', agency: false, method: [], contacts: [], error: (err as Error).message }) as const,
    );
    setEnrichment(job.id, { ...e, method: [...e.method], contacts: [...e.contacts] });
    return e;
  } finally {
    inFlight.delete(job.id);
  }
}

function notify(jobs: Job[]): void {
  if (process.platform !== 'darwin') return;
  const top = [...jobs].sort((a, b) => (b.match.score ?? 0) - (a.match.score ?? 0))[0];
  const text = msg('notify', jobs.length, top.title, top.company ?? top.sourceName).replace(/["\\]/g, '');
  // execFile with args array – no shell interpolation of scraped text
  execFile('osascript', ['-e', `display notification "${text}" with title "Jobs scraper"`], () => {});
}

let timer: NodeJS.Timeout | null = null;

function armTimer(): void {
  if (timer) clearTimeout(timer);
  const minutes = Math.max(5, getConfig().settings.scanIntervalMinutes);
  state.nextScanAt = new Date(Date.now() + minutes * 60_000).toISOString();
  timer = setTimeout(async () => {
    await runScan().catch((e) => log(msg('scanFailed'), e));
    armTimer();
  }, minutes * 60_000);
}

/** Scan right away, then every `scanIntervalMinutes`. */
export function startScheduler(): void {
  runScan()
    .catch((e) => log(msg('scanFailed'), e))
    .finally(armTimer);
}

/** Restart the countdown (after the interval was changed in settings). */
export function rescheduleScanner(): void {
  if (timer) armTimer();
}
