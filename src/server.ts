import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { defaultConfig, getConfig, saveConfig } from './config.ts';
import { extractTagsFromText, KNOWN_TECH } from './match.ts';
import { formatSalary } from './salary.ts';
import { onScanEvent, rescheduleScanner, runEnrich, runScan, state } from './scanner.ts';
import { ADAPTERS } from './sources/index.ts';
import { getJob, reevaluateAll, removeSourceJobs, setStatus, visibleJobs } from './store.ts';
import type { AdapterType, AppConfig, Filters, Job, JobStatus, Profile, Settings, SourceConfig } from './types.ts';

const PUBLIC_DIR = path.resolve(import.meta.dirname, '..', 'public');
const STATIC: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/i18n.js': 'i18n.js',
  '/styles.css': 'styles.css',
};
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const STATUSES: JobStatus[] = ['new', 'watch', 'applied', 'rejected'];

class BadRequest extends Error {}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new BadRequest('Příliš velký požadavek');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new BadRequest('Neplatný JSON');
  }
}

// ---------------------------------------------------------------- validation helpers
const strList = (v: unknown, field: string, max = 200): string[] => {
  if (!Array.isArray(v)) throw new BadRequest(`${field} musí být pole`);
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, max).map((s) => s.slice(0, 200));
};
const num = (v: unknown, field: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequest(`${field}: číslo ${min}–${max}`);
  return n;
};
const httpUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
};

function parseSource(body: Record<string, unknown>, existing?: SourceConfig): SourceConfig {
  const type = String(body.type ?? existing?.type) as AdapterType;
  if (!ADAPTERS[type]) throw new BadRequest('Neznámý typ zdroje');
  const name = String(body.name ?? existing?.name ?? '').trim().slice(0, 80);
  if (!name) throw new BadRequest('Chybí název');
  const urls = strList(body.urls ?? existing?.urls ?? [], 'urls', 50);
  const bad = urls.find((u) => !httpUrl(u));
  if (bad) throw new BadRequest(`Neplatná URL: ${bad}`);
  if (!urls.length) throw new BadRequest('Zadej alespoň jednu URL');
  let selectors = existing?.selectors;
  if (body.selectors !== undefined) {
    const s = body.selectors as Record<string, unknown> | null;
    selectors = s
      ? {
          item: String(s.item ?? ''),
          title: String(s.title ?? ''),
          link: s.link ? String(s.link) : undefined,
          company: s.company ? String(s.company) : undefined,
          location: s.location ? String(s.location) : undefined,
          salary: s.salary ? String(s.salary) : undefined,
        }
      : undefined;
  }
  if (type === 'html' && (!selectors?.item || !selectors?.title)) throw new BadRequest('HTML zdroj potřebuje selektory item a title');
  const id =
    existing?.id ??
    (name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'zdroj') + `-${Date.now().toString(36)}`;
  return {
    id,
    name,
    type,
    enabled: body.enabled === undefined ? (existing?.enabled ?? true) : Boolean(body.enabled),
    urls,
    maxPages: body.maxPages === undefined ? (existing?.maxPages ?? 1) : num(body.maxPages, 'maxPages', 1, 10),
    selectors,
  };
}

// ---------------------------------------------------------------- serialization
function jobSummary(j: Job) {
  const { description, ...rest } = j;
  return {
    ...rest,
    salaryLabel: j.salary ? formatSalary(j.salary) : j.salaryText,
    excerpt: description ? description.slice(0, 700) : undefined,
    hasDescription: !!description,
  };
}

function publicState(cfg: AppConfig) {
  return {
    scan: state,
    config: cfg,
    adapters: Object.fromEntries(
      Object.entries(ADAPTERS).map(([k, a]) => [k, { label: a.label, hint: a.hint, labelEn: a.labelEn ?? a.label, hintEn: a.hintEn ?? a.hint }]),
    ),
    knownTech: KNOWN_TECH,
  };
}

// ---------------------------------------------------------------- SSE
const clients = new Set<http.ServerResponse>();
onScanEvent((event, payload) => {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
  for (const c of clients) c.write(data);
});

// ---------------------------------------------------------------- routes
async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const parts = url.pathname.split('/').filter(Boolean); // ["api", ...]
  const cfg = getConfig();

  if (method === 'GET' && url.pathname === '/api/state') return send(res, 200, publicState(cfg));
  if (method === 'GET' && url.pathname === '/api/jobs') return send(res, 200, visibleJobs().map(jobSummary));

  if (method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('event: hello\ndata: {}\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (method === 'POST' && parts[1] === 'jobs' && parts[2] && parts[3] === 'enrich') {
    const j = getJob(decodeURIComponent(parts[2]));
    if (!j) return send(res, 404, { error: 'Nenalezeno' });
    await runEnrich(j);
    return send(res, 200, { ...jobSummary(j), description: j.description });
  }

  if (parts[1] === 'jobs' && parts[2] && !parts[3]) {
    const id = decodeURIComponent(parts[2]);
    if (method === 'GET') {
      const j = getJob(id);
      return j ? send(res, 200, { ...jobSummary(j), description: j.description }) : send(res, 404, { error: 'Nenalezeno' });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const status = (body.status ?? getJob(id)?.status) as JobStatus;
      if (!STATUSES.includes(status)) throw new BadRequest('Neplatný status');
      const j = setStatus(id, status, body.note === undefined ? undefined : String(body.note));
      return j ? send(res, 200, jobSummary(j)) : send(res, 404, { error: 'Nenalezeno' });
    }
  }

  if (method === 'POST' && url.pathname === '/api/scan') {
    const body = await readBody(req);
    const sourceId = body.sourceId ? String(body.sourceId) : undefined;
    if (state.running) return send(res, 409, { error: 'Sken už běží' });
    void runScan(sourceId);
    return send(res, 202, { ok: true });
  }

  if (method === 'POST' && url.pathname === '/api/ack') {
    cfg.lastAcknowledgedAt = new Date().toISOString();
    saveConfig(cfg);
    return send(res, 200, { lastAcknowledgedAt: cfg.lastAcknowledgedAt });
  }

  if (method === 'PUT' && url.pathname === '/api/profile') {
    const b = await readBody(req);
    const profile: Profile = {
      core: strList(b.core, 'core'),
      strong: strList(b.strong, 'strong'),
      familiar: strList(b.familiar, 'familiar'),
      avoid: strList(b.avoid, 'avoid'),
    };
    saveConfig({ ...cfg, profile });
    reevaluateAll(getConfig());
    return send(res, 200, publicState(getConfig()));
  }

  if (method === 'POST' && url.pathname === '/api/profile/import') {
    const b = await readBody(req);
    return send(res, 200, { tags: extractTagsFromText(String(b.text ?? '')) });
  }

  if (method === 'PUT' && url.pathname === '/api/filters') {
    const b = await readBody(req);
    const filters: Filters = {
      minSalaryCzkMonth: num(b.minSalaryCzkMonth, 'minSalaryCzkMonth', 0, 10_000_000),
      hideUnknownSalary: Boolean(b.hideUnknownSalary),
      titleInclude: strList(b.titleInclude, 'titleInclude'),
      titleGeneric: strList(b.titleGeneric, 'titleGeneric'),
      titleExclude: strList(b.titleExclude, 'titleExclude'),
      onsiteCities: strList(b.onsiteCities, 'onsiteCities'),
      remoteAllowed: strList(b.remoteAllowed, 'remoteAllowed'),
      remoteBlocked: strList(b.remoteBlocked, 'remoteBlocked'),
    };
    for (const p of [...filters.titleInclude, ...filters.titleGeneric, ...filters.titleExclude, ...filters.remoteAllowed, ...filters.remoteBlocked]) {
      try {
        new RegExp(p, 'i');
      } catch {
        throw new BadRequest(`Neplatný regex: ${p}`);
      }
    }
    saveConfig({ ...cfg, filters });
    reevaluateAll(getConfig());
    return send(res, 200, publicState(getConfig()));
  }

  if (method === 'PUT' && url.pathname === '/api/settings') {
    const b = await readBody(req);
    const settings: Settings = {
      ...cfg.settings,
      scanIntervalMinutes: num(b.scanIntervalMinutes, 'scanIntervalMinutes', 5, 24 * 60),
      notifications: Boolean(b.notifications),
      openBrowser: Boolean(b.openBrowser),
      maxDetailFetchesPerScan: num(b.maxDetailFetchesPerScan, 'maxDetailFetchesPerScan', 0, 500),
      goneAfterHours: num(b.goneAfterHours, 'goneAfterHours', 1, 24 * 60),
      maxEnrichPerScan: b.maxEnrichPerScan === undefined ? cfg.settings.maxEnrichPerScan : num(b.maxEnrichPerScan, 'maxEnrichPerScan', 0, 500),
    };
    saveConfig({ ...cfg, settings });
    rescheduleScanner();
    return send(res, 200, publicState(getConfig()));
  }

  if (method === 'POST' && url.pathname === '/api/language') {
    const b = await readBody(req);
    if (b.language !== 'cs' && b.language !== 'en') throw new BadRequest('Unsupported language');
    saveConfig({ ...cfg, settings: { ...cfg.settings, language: b.language } });
    return send(res, 200, publicState(getConfig()));
  }

  if (method === 'POST' && url.pathname === '/api/defaults/filters') {
    saveConfig({ ...cfg, filters: defaultConfig().filters });
    reevaluateAll(getConfig());
    return send(res, 200, publicState(getConfig()));
  }

  if (parts[1] === 'sources') {
    const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
    if (method === 'POST' && !id) {
      const src = parseSource(await readBody(req));
      saveConfig({ ...cfg, sources: [...cfg.sources, src] });
      return send(res, 201, publicState(getConfig()));
    }
    const existing = cfg.sources.find((s) => s.id === id);
    if (!existing) return send(res, 404, { error: 'Zdroj nenalezen' });
    if (method === 'PUT') {
      const src = parseSource(await readBody(req), existing);
      saveConfig({ ...cfg, sources: cfg.sources.map((s) => (s.id === id ? src : s)) });
      return send(res, 200, publicState(getConfig()));
    }
    if (method === 'DELETE') {
      saveConfig({ ...cfg, sources: cfg.sources.filter((s) => s.id !== id) });
      removeSourceJobs(existing.id);
      return send(res, 200, publicState(getConfig()));
    }
  }

  send(res, 404, { error: 'Neznámý endpoint' });
}

export function startServer(port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      // DNS-rebinding guard: only answer to localhost host names.
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host ?? '')) return send(res, 403, { error: 'Neplatný host' });
      if (url.pathname.startsWith('/api/')) {
        // CSRF guard: mutating calls only from our own page (a browser always sends Origin on cross-site POST).
        if (req.method !== 'GET') {
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Cizí origin' });
          if (!String(req.headers['content-type'] ?? '').includes('application/json'))
            return send(res, 415, { error: 'Očekávám application/json' });
        }
        return await handleApi(req, res, url);
      }
      const file = STATIC[url.pathname];
      if (!file || req.method !== 'GET') return send(res, 404, { error: 'Nenalezeno' });
      const full = path.join(PUBLIC_DIR, file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)], 'Cache-Control': 'no-cache' });
      fs.createReadStream(full).pipe(res);
    } catch (err) {
      if (err instanceof BadRequest) return send(res, 400, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Interní chyba' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Localhost only – the dashboard is a personal tool.
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
