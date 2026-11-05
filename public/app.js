// Dashboard – vanilla JS, no build step.
// All scraped content is rendered via textContent (el() helper) – never innerHTML – to avoid XSS.
// UI strings: t('key') from i18n.js; Czech strings produced by the server go through tr().
import { applyStatic, getLang, locale, n, setLang, t, tr, trSalary } from './i18n.js';

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny hyperscript: el('div', {class: 'x', onclick}, child, 'text', [more]) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'href') node.setAttribute('href', safeHref(v));
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const safeHref = (u) => (/^https?:\/\//i.test(String(u)) || /^mailto:[^\s@<>"]+@[^\s@<>"]+$/i.test(String(u)) ? String(u) : '#');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 2600) {
  const box = $('#toast');
  box.textContent = msg;
  box.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => box.classList.add('hidden'), ms);
}

const fmtCzk = (n) => (n == null ? '?' : `${Math.round(n / 1000).toLocaleString(locale())} ${t('salary.thousands')}`);
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 90) return t('time.now');
  if (s < 3600) return t('time.min', Math.round(s / 60));
  if (s < 86400) return t('time.h', Math.round(s / 3600));
  return t('time.d', Math.round(s / 86400));
}
const until = (iso) => {
  const m = Math.round((Date.parse(iso) - Date.now()) / 60000);
  return m <= 0 ? t('time.soon') : t('time.inMin', m);
};

// ------------------------------------------------------------------ state
const S = {
  jobs: [],
  config: null,
  scan: null,
  adapters: {},
  knownTech: [],
  expanded: new Set(),
  editingSource: null, // source id | 'new' | null
  renderLimit: 100,
};

const PREFS_KEY = 'jobs-scraper-prefs';
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {};
  } catch {
    return {};
  }
})();
const savePrefs = () => {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
};

async function loadState() {
  const st = await api('/api/state');
  if (st.config.settings.language !== getLang()) applyLanguage(st.config.settings.language);
  S.config = st.config;
  S.scan = st.scan;
  S.adapters = st.adapters;
  S.knownTech = st.knownTech;
  renderScanStatus();
}
let pendingJobsReload = false;
const editingNote = () => document.activeElement?.matches?.('#jobs-list textarea');
async function loadJobs() {
  if (editingNote()) {
    pendingJobsReload = true; // re-render after the textarea loses focus
    return;
  }
  pendingJobsReload = false;
  S.jobs = await api('/api/jobs');
  renderJobs();
}

// ------------------------------------------------------------------ top bar
function renderScanStatus() {
  const s = S.scan;
  const node = $('#scan-status');
  node.replaceChildren();
  if (s.running) {
    const running = Object.values(s.sources).filter((x) => !x.finishedAt && Date.parse(x.startedAt) >= Date.parse(s.lastScanStartedAt));
    node.append(el('span', { class: 'spinner' }), `${t('scan.running')} ${running.length ? `(${running.map((r) => sourceName(r.sourceId)).join(', ')})` : ''}`);
  } else {
    node.append(
      s.lastScanFinishedAt ? t('scan.last', ago(s.lastScanFinishedAt)) : t('scan.never'),
      s.nextScanAt ? t('scan.next', until(s.nextScanAt)) : '',
    );
  }
  $('#btn-scan').disabled = s.running;
}
const adapterLabel = (type) => {
  const a = S.adapters[type];
  return (getLang() === 'en' ? a?.labelEn : a?.label) ?? type;
};
const sourceName = (id) => tr(S.config?.sources.find((s) => s.id === id)?.name ?? id);

$('#btn-scan').addEventListener('click', async () => {
  try {
    await api('/api/scan', { method: 'POST', body: {} });
    S.scan.running = true;
    renderScanStatus();
    toast(t('scan.started'));
  } catch (e) {
    toast(tr(e.message));
  }
});
$('#btn-ack').addEventListener('click', async () => {
  try {
    const r = await api('/api/ack', { method: 'POST', body: {} });
    S.config.lastAcknowledgedAt = r.lastAcknowledgedAt;
    renderJobs();
  } catch (e) {
    toast(tr(e.message));
  }
});

// ------------------------------------------------------------------ language
function applyLanguage(lang) {
  setLang(lang);
  applyStatic();
  for (const b of document.querySelectorAll('#lang-seg button')) b.classList.toggle('active', b.dataset.lang === lang);
}

for (const b of document.querySelectorAll('#lang-seg button')) {
  b.addEventListener('click', async () => {
    if (b.dataset.lang === getLang()) return;
    try {
      applyState(await api('/api/language', { method: 'POST', body: { language: b.dataset.lang } }));
      applyLanguage(b.dataset.lang);
      // re-render everything built with the previous language – without losing unsaved input
      renderScanStatus();
      renderJobs();
      if (!$('#view-sources').classList.contains('hidden') && !S.editingSource) renderSources();
      if (!$('#view-profile').classList.contains('hidden')) {
        const drafts = Object.fromEntries(Object.entries(editors).map(([k, e]) => [k, e.getTags()]));
        const fields = ['#filters-form', '#settings-form'].map((f) => [...document.querySelectorAll(`${f} input, ${f} textarea`)].map((i) => (i.type === 'checkbox' ? i.checked : i.value)));
        renderProfile(drafts);
        ['#filters-form', '#settings-form'].forEach((f, fi) =>
          document.querySelectorAll(`${f} input, ${f} textarea`).forEach((i, ii) => {
            const v = fields[fi][ii];
            if (v === undefined) return;
            if (i.type === 'checkbox') i.checked = v;
            else i.value = v;
          }),
        );
      }
    } catch (e) {
      toast(tr(e.message));
    }
  });
}

// ------------------------------------------------------------------ tabs
function showTab(name) {
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === name);
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.id !== `view-${name}`);
  prefs.tab = name;
  savePrefs();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  if (name === 'sources') renderSources();
  if (name === 'profile') renderProfile();
}
for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showTab(b.dataset.tab));

// ------------------------------------------------------------------ jobs view
const F = {
  status: prefs.status ?? 'todo',
  search: '',
  sort: prefs.sort ?? 'match',
  minMatch: Number(prefs.minMatch ?? 0),
  source: '',
  modes: prefs.modes ?? { remote: true, hybrid: true, onsite: true },
  salaryKnown: prefs.salaryKnown ?? false,
  unclear: prefs.unclear ?? false,
  failed: false,
  gone: prefs.gone ?? true,
};

function bindFilters() {
  for (const b of document.querySelectorAll('#status-seg button')) {
    b.classList.toggle('active', b.dataset.status === F.status);
    b.addEventListener('click', () => {
      F.status = b.dataset.status;
      prefs.status = F.status;
      savePrefs();
      for (const x of document.querySelectorAll('#status-seg button')) x.classList.toggle('active', x === b);
      renderJobs();
    });
  }
  const bind = (id, key, get, set) => {
    const n = $(id);
    set(n);
    n.addEventListener(n.type === 'search' ? 'input' : 'change', () => {
      F[key] = get(n);
      if (key !== 'search' && key !== 'source' && key !== 'failed') {
        prefs[key] = F[key];
        savePrefs();
      }
      renderJobs();
    });
  };
  bind('#f-search', 'search', (n) => n.value, () => {});
  bind('#f-sort', 'sort', (n) => n.value, (n) => (n.value = F.sort));
  bind('#f-minmatch', 'minMatch', (n) => Number(n.value), (n) => (n.value = String(F.minMatch)));
  bind('#f-source', 'source', (n) => n.value, () => {});
  bind('#f-salary-known', 'salaryKnown', (n) => n.checked, (n) => (n.checked = F.salaryKnown));
  bind('#f-unclear', 'unclear', (n) => n.checked, (n) => (n.checked = F.unclear));
  bind('#f-failed', 'failed', (n) => n.checked, (n) => (n.checked = F.failed));
  bind('#f-gone', 'gone', (n) => n.checked, (n) => (n.checked = F.gone));
  for (const m of ['remote', 'hybrid', 'onsite']) {
    const n = $(`#f-mode-${m}`);
    n.checked = F.modes[m];
    n.addEventListener('change', () => {
      F.modes[m] = n.checked;
      prefs.modes = F.modes;
      savePrefs();
      renderJobs();
    });
  }
}

const isNew = (j) => !S.config?.lastAcknowledgedAt || j.firstSeenAt > S.config.lastAcknowledgedAt;
const hasRecentChange = (j) =>
  j.changes?.some((c) => c.field !== 'gone' && (!S.config?.lastAcknowledgedAt || c.at > S.config.lastAcknowledgedAt));

function statusPass(j) {
  switch (F.status) {
    case 'todo':
      return j.status === 'new' || j.status === 'watch';
    case 'all':
      return true;
    default:
      return j.status === F.status;
  }
}

function filterJobs() {
  const q = F.search.trim().toLowerCase();
  // User-marked jobs (watch/applied) always show, regardless of automatic filters.
  const keepAnyway = (j) => j.status === 'watch' || j.status === 'applied';
  return S.jobs.filter((j) => {
    if (!statusPass(j)) return false;
    if (F.source && j.sourceId !== F.source && !j.links.some((l) => l.sourceId === F.source)) return false;
    if (q) {
      const hay = [j.title, j.company, j.location, ...(j.match.matched ?? []), ...(j.match.missing ?? []), ...(j.tags ?? [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (keepAnyway(j)) return true;
    const v = j.evaluation.verdict;
    if (v === 'fail' && !F.failed) return false;
    if (v === 'unclear' && !F.unclear && !F.failed) return false;
    const mode = j.evaluation.workMode === 'unknown' ? 'onsite' : j.evaluation.workMode;
    if (!F.modes[mode]) return false;
    if (F.salaryKnown && j.evaluation.salary === 'unknown') return false;
    if (F.minMatch && (j.match.score ?? 0) < F.minMatch) return false;
    if (!F.gone && j.gone) return false;
    return true;
  });
}

function sortJobs(list) {
  const top = (j) => j.evaluation.salaryCzkMonth?.max ?? j.evaluation.salaryCzkMonth?.min ?? -1;
  const by = {
    match: (a, b) => (b.match.score ?? -1) - (a.match.score ?? -1) || top(b) - top(a),
    salary: (a, b) => top(b) - top(a) || (b.match.score ?? -1) - (a.match.score ?? -1),
    newest: (a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt),
  }[F.sort];
  return list.sort((a, b) => Number(isNew(b)) - Number(isNew(a)) || by(a, b));
}

function renderJobs() {
  const list = sortJobs(filterJobs());
  const active = S.jobs.filter((j) => j.status !== 'rejected');
  const ok = active.filter((j) => j.evaluation.verdict === 'ok');
  const newCount = ok.filter((j) => isNew(j) && j.status === 'new').length;
  $('#tab-count').textContent = `${ok.length}${newCount ? t('tab.count.new', n('new', newCount)) : ''}`;
  document.title = newCount ? `(${newCount}) Jobs scraper` : 'Jobs scraper';
  $('#cnt-unclear').textContent = `(${active.filter((j) => j.evaluation.verdict === 'unclear').length})`;
  $('#cnt-failed').textContent = `(${active.filter((j) => j.evaluation.verdict === 'fail').length})`;

  // source select
  const sel = $('#f-source');
  const current = sel.value;
  sel.replaceChildren(el('option', { value: '' }, t('f.source.all')), ...(S.config?.sources ?? []).map((s) => el('option', { value: s.id }, tr(s.name))));
  sel.value = current;

  const newInList = list.filter((j) => isNew(j) && j.status === 'new').length;
  $('#jobs-summary').textContent = `${t('jobs.summary', list.length, S.jobs.length)}${newInList ? t('jobs.summary.new', n('new', newInList)) : ''}.`;
  const box = $('#jobs-list');
  if (!list.length) {
    box.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        S.jobs.length ? t('jobs.empty.filtered') : S.scan?.running ? t('jobs.empty.firstScan') : t('jobs.empty.none'),
      ),
    );
    return;
  }
  // Render in pages of 100 for snappiness – the "show more" button appends the next page
  const shown = list.slice(0, S.renderLimit);
  box.replaceChildren(
    ...shown.map(jobCard),
    list.length > shown.length
      ? el('button', { class: 'btn', style: 'align-self:center', onclick: () => ((S.renderLimit += 100), renderJobs()) }, t('jobs.more', Math.min(100, list.length - shown.length), list.length - shown.length))
      : null,
  );
}

function scoreRing(score) {
  const p = score ?? 0;
  const color = score == null ? 'var(--border)' : p >= 75 ? 'var(--good)' : p >= 50 ? 'var(--primary)' : p >= 30 ? 'var(--warn)' : 'var(--bad)';
  return el(
    'div',
    { title: t('card.matchTitle') },
    el('div', { class: 'score', style: `--p:${p};--ring:${color}` }, el('span', {}, score == null ? '–' : `${score}%`)),
    el('small', { class: 'muted', style: 'display:block;text-align:center;font-size:10px;margin-top:3px' }, 'match'),
  );
}

const MODE_LABEL = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'Onsite', unknown: '?' };

function jobCard(j) {
  const ev = j.evaluation;
  const czk = ev.salaryCzkMonth;
  const expanded = S.expanded.has(j.id);

  const action = (status, label, title) =>
    el(
      'button',
      {
        class: `btn act ${j.status === status ? `on ${status}` : ''}`,
        title,
        onclick: () => updateStatus(j, j.status === status ? 'new' : status),
      },
      label,
    );

  const badges = [
    isNew(j) && j.status === 'new' ? el('span', { class: 'badge b-new' }, t('badge.new')) : null,
    hasRecentChange(j) && !isNew(j) ? el('span', { class: 'badge b-change', title: changesText(j) }, t('badge.changed')) : null,
    j.gone ? el('span', { class: 'badge b-gone', title: t('badge.gone.title') }, t('badge.gone')) : null,
    el('span', { class: 'badge b-mode' }, MODE_LABEL[ev.workMode]),
    ...ev.reasons.map((r) => el('span', { class: `badge ${ev.verdict === 'fail' ? 'b-fail' : 'b-warn'}` }, tr(r))),
  ];

  return el(
    'article',
    { class: `job st-${j.status} ${j.gone ? 'gone' : ''}` },
    scoreRing(j.match.score),
    el(
      'div',
      { class: 'job-main' },
      el('a', { class: 'job-title', href: j.url, target: '_blank', rel: 'noopener noreferrer' }, j.title),
      el(
        'div',
        { class: 'job-meta' },
        j.company ? el('b', {}, j.company) : null,
        j.location ? el('span', {}, `📍 ${j.location.length > 80 ? `${j.location.slice(0, 80)}…` : j.location}`) : null,
        el('span', {}, `🔎 ${[j.sourceName, ...j.links.map((l) => l.sourceName)].map(tr).join(', ')}`),
        el('span', { title: new Date(j.firstSeenAt).toLocaleString(locale()) }, `🕑 ${ago(j.firstSeenAt)}`),
      ),
      enrichLine(j),
      el('div', { class: 'chips' }, badges),
      el(
        'div',
        { class: 'chips' },
        j.match.matched.map((tag) => el('span', { class: 'chip match' }, tag)),
        j.match.avoided.map((tag) => el('span', { class: 'chip avoid', title: t('chip.avoid.title') }, tag)),
        j.match.missing.map((tag) => el('span', { class: 'chip missing', title: t('chip.missing.title') }, tag)),
        j.match.score == null && !j.hasDescription ? el('span', { class: 'chip missing' }, t('chip.unknownStack')) : null,
      ),
    ),
    el(
      'div',
      { class: 'job-side' },
      j.salaryLabel ? el('div', { class: `salary ${ev.salary === 'ok' ? 'ok' : ev.salary === 'fail' ? 'fail' : ''}` }, j.salary ? trSalary(j.salaryLabel) : j.salaryLabel) : el('div', { class: 'muted' }, t('salary.none')),
      // Show the CZK/month equivalent only when the original isn't already CZK per month
      czk && (czk.min ?? czk.max) != null && (j.salary?.currency !== 'CZK' || j.salary?.period !== 'month')
        ? el('div', { class: 'salary-czk' }, `≈ ${czk.min && czk.max && czk.min !== czk.max ? `${fmtCzk(czk.min)}–${fmtCzk(czk.max)}` : fmtCzk(czk.max ?? czk.min)} ${t('salary.perMonth')}`)
        : null,
      el(
        'div',
        { class: 'actions' },
        action('applied', t('act.applied'), t('act.applied.title')),
        action('watch', t('act.watch'), t('act.watch.title')),
        action('rejected', t('act.reject'), t('act.reject.title')),
      ),
      el('button', { class: 'linkish', onclick: () => toggleDetail(j) }, expanded ? t('detail.hide') : t('detail.show')),
    ),
    expanded ? detailBox(j) : null,
  );
}

const VERIFY = () => el('span', { class: 'badge b-warn', title: t('enrich.verify.title') }, t('enrich.verify'));

function enrichLine(j) {
  const e = j.enrichment;
  if (!e) return null;
  const items = [];
  if (e.originalUrl) items.push(el('a', { href: e.originalUrl, target: '_blank', rel: 'noopener noreferrer', class: 'orig' }, t('enrich.original')));
  else if (e.careersUrl) items.push(el('a', { href: e.careersUrl, target: '_blank', rel: 'noopener noreferrer', class: 'orig' }, t('enrich.careers')));
  if (e.agency) items.push(el('span', { class: 'badge b-fail', title: t('enrich.agency.title') }, t('enrich.agency')));
  if (e.contacts?.length) items.push(el('span', { class: 'muted' }, t('enrich.contacts', n('contacts', e.contacts.length))));
  if (!items.length) return null;
  if (e.originalUrl || e.careersUrl || e.contacts?.length) items.push(VERIFY());
  return el('div', { class: 'job-meta enrich' }, items);
}

function enrichBox(j) {
  const e = j.enrichment;
  const btn = el(
    'button',
    {
      class: 'btn small',
      onclick: async () => {
        btn.disabled = true;
        btn.textContent = t('enrich.searching');
        try {
          const updated = await api(`/api/jobs/${encodeURIComponent(j.id)}/enrich`, { method: 'POST', body: {} });
          Object.assign(S.jobs.find((x) => x.id === j.id) ?? j, updated);
          details.set(j.id, updated);
          const st = updated.enrichment?.status;
          toast(st ? t(`enrich.toast.${st}`) : t('enrich.toast.done'));
        } catch (err) {
          toast(tr(err.message));
        }
        renderJobs();
      },
    },
    e ? t('enrich.again') : t('enrich.run'),
  );
  const statusText = e
    ? t(`enrich.st.${e.status}`, tr(e.error ?? ''))
    : t('enrich.st.none');
  return el(
    'div',
    { class: 'enrich-box' },
    el('div', { class: 'row', style: 'margin-top:0' }, el('b', {}, t('enrich.heading')), e && (e.originalUrl || e.careersUrl || e.contacts?.length) ? VERIFY() : null, btn),
    el('div', { class: 'muted' }, statusText, e ? ` · ${ago(e.at)}` : ''),
    e?.originalUrl ? el('div', {}, t('enrich.lbl.original'), el('a', { href: e.originalUrl, target: '_blank', rel: 'noopener noreferrer' }, e.originalUrl)) : null,
    e?.careersUrl && e.careersUrl !== e.originalUrl ? el('div', {}, t('enrich.lbl.careers'), el('a', { href: e.careersUrl, target: '_blank', rel: 'noopener noreferrer' }, e.careersUrl)) : null,
    e?.externalUrl && !e.originalUrl ? el('div', {}, t('enrich.lbl.external'), el('a', { href: e.externalUrl, target: '_blank', rel: 'noopener noreferrer' }, e.externalUrl)) : null,
    e?.companySite ? el('div', {}, t('enrich.lbl.site'), el('a', { href: e.companySite, target: '_blank', rel: 'noopener noreferrer' }, e.companySite)) : null,
    e?.contacts?.length
      ? el(
          'ul',
          { class: 'contacts' },
          e.contacts.map((c) =>
            el(
              'li',
              {},
              c.type === 'email' ? el('a', { href: `mailto:${c.value}` }, c.value) : el('span', {}, c.value),
              ' ',
              el('span', { class: 'badge b-warn' }, tr(c.note)),
              ' ',
              el('span', { class: 'muted' }, /^https?:/.test(c.source) ? el('a', { href: c.source, target: '_blank', rel: 'noopener noreferrer' }, t('enrich.source')) : tr(c.source)),
            ),
          ),
        )
      : null,
    e?.method?.length ? el('div', { class: 'muted', style: 'font-size:12px' }, t('enrich.steps', e.method.map(tr).join(' → '))) : null,
  );
}

// Change-log values: salary labels / gone markers come from the server; titles & locations are scraped data → as is.
const chg = (c, v) => (c.field === 'salary' ? trSalary(v) : c.field === 'gone' || c.field === 'reappeared' ? tr(v) : v);

function changesText(j) {
  return (j.changes ?? [])
    .slice(0, 6)
    .map((c) => `${new Date(c.at).toLocaleString(locale())}: ${t(`change.${c.field}`)}${c.from ? ` „${chg(c, c.from)}" →` : ''} ${chg(c, c.to ?? '')}`)
    .join('\n');
}

const details = new Map();
const noteDrafts = new Map(); // unsaved note text survives re-renders during a scan
const noteTimers = new Map();
async function saveNote(j, value) {
  clearTimeout(noteTimers.get(j.id));
  noteTimers.delete(j.id);
  try {
    const updated = await api(`/api/jobs/${encodeURIComponent(j.id)}`, { method: 'PATCH', body: { note: value } });
    // S.jobs may have been reloaded meanwhile – update the current object, not the captured one
    Object.assign(S.jobs.find((x) => x.id === j.id) ?? j, updated);
    if (noteDrafts.get(j.id) === value) noteDrafts.delete(j.id);
  } catch (e) {
    toast(t('detail.noteFail', tr(e.message)));
  }
}
function detailBox(j) {
  const d = details.get(j.id);
  const note = el('textarea', { rows: 2, placeholder: t('detail.note') });
  note.dataset.jobId = j.id;
  note.value = noteDrafts.get(j.id) ?? j.note ?? '';
  note.addEventListener('input', () => {
    noteDrafts.set(j.id, note.value);
    clearTimeout(noteTimers.get(j.id));
    noteTimers.set(j.id, setTimeout(() => saveNote(j, note.value), 800));
  });
  note.addEventListener('blur', async () => {
    if (noteDrafts.has(j.id)) await saveNote(j, note.value); // save first, then reload – no stale GET
    if (pendingJobsReload) loadJobs();
  });
  return el(
    'div',
    { class: 'detail' },
    enrichBox(j),
    j.links.length
      ? el('div', { class: 'links' }, t('detail.alsoOn'), j.links.map((l, i) => [i ? ', ' : '', el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, tr(l.sourceName))]))
      : null,
    j.changes?.length ? el('ul', { class: 'changes' }, j.changes.slice(0, 8).map((c) => el('li', {}, `${new Date(c.at).toLocaleString(locale())} – ${t(`change.${c.field}`)}: ${c.from ? `${chg(c, c.from)} → ` : ''}${chg(c, c.to ?? '')}`))) : null,
    j.tags?.length ? el('div', { class: 'chips' }, j.tags.slice(0, 30).map((tag) => el('span', { class: 'chip' }, tag))) : null,
    el('div', { class: 'desc', style: 'margin-top:8px' }, d?.description ?? j.excerpt ?? t('detail.noDesc')),
    el('div', { style: 'margin-top:8px' }, note),
  );
}

async function toggleDetail(j) {
  if (S.expanded.has(j.id)) S.expanded.delete(j.id);
  else {
    S.expanded.add(j.id);
    if (!details.has(j.id) && j.hasDescription) {
      try {
        details.set(j.id, await api(`/api/jobs/${encodeURIComponent(j.id)}`));
      } catch (e) {
        toast(t('detail.loadFail', tr(e.message))); // excerpt is shown instead
      }
    }
  }
  renderJobs();
}

async function updateStatus(j, status) {
  try {
    const updated = await api(`/api/jobs/${encodeURIComponent(j.id)}`, { method: 'PATCH', body: { status } });
    Object.assign(j, updated);
    renderJobs();
    toast(t(`status.${status}`));
  } catch (e) {
    toast(tr(e.message));
  }
}

// ------------------------------------------------------------------ sources view
function renderSources() {
  const slot = $('#source-form-slot');
  slot.replaceChildren(S.editingSource === 'new' ? sourceForm(null) : '');
  const list = $('#sources-list');
  list.replaceChildren(
    ...S.config.sources.map((s) => {
      if (S.editingSource === s.id) return sourceForm(s);
      const run = S.scan.sources[s.id];
      const toggle = el('input', { type: 'checkbox', checked: s.enabled });
      toggle.addEventListener('change', () => saveSource(s, { ...s, enabled: toggle.checked }));
      return el(
        'div',
        { class: `source ${s.enabled ? '' : 'disabled'}` },
        el('label', { class: 'switch', title: s.enabled ? t('src.disable') : t('src.enable') }, toggle, el('span')),
        el(
          'div',
          {},
          el('div', {}, el('span', { class: 'source-name' }, tr(s.name)), ' ', el('span', { class: 'muted' }, `· ${adapterLabel(s.type)} · ${t('src.pages', s.maxPages)}`)),
          el('div', { class: 'source-urls' }, s.urls.map((u) => el('div', {}, u))),
          run
            ? el(
                'div',
                { class: 'source-run' },
                run.finishedAt
                  ? t('src.run', `${run.ok ? '✓' : '✗'} ${ago(run.finishedAt)}`, run.fetched, run.relevant, run.newJobs)
                  : el('span', {}, el('span', { class: 'spinner' }), t('src.running')),
                run.errors?.length
                  ? el('details', {}, el('summary', { class: 'err' }, t('src.errors', n('errors', run.errors.length))), el('div', { class: 'source-urls' }, run.errors.map((e) => el('div', {}, tr(e)))))
                  : null,
              )
            : el('div', { class: 'source-run muted' }, t('src.never')),
        ),
        el(
          'div',
          { class: 'row', style: 'margin-top:0' },
          el('button', { class: 'btn small', disabled: S.scan.running, onclick: () => scanOne(s) }, t('src.scan')),
          el('button', { class: 'btn small', onclick: () => ((S.editingSource = s.id), renderSources()) }, t('src.edit')),
          el('button', { class: 'btn small danger', onclick: () => deleteSource(s) }, t('src.delete')),
        ),
      );
    }),
  );
}

function sourceForm(s) {
  const isNewSrc = !s;
  const name = el('input', { type: 'text', value: s?.name ?? '', placeholder: t('src.namePh') });
  const type = el('select', {}, Object.keys(S.adapters).map((k) => el('option', { value: k }, adapterLabel(k))));
  type.value = s?.type ?? 'html';
  const pages = el('input', { type: 'number', min: 1, max: 10, value: s?.maxPages ?? 1 });
  const urls = el('textarea', { rows: 4, placeholder: t('src.urlsPh') });
  urls.value = (s?.urls ?? []).join('\n');
  const hint = el('div', { class: 'muted', style: 'font-size:12px' });
  const selFields = ['item', 'title', 'link', 'company', 'location', 'salary'].map((k) => {
    const i = el('input', { type: 'text', value: s?.selectors?.[k] ?? '', placeholder: k === 'item' ? '.job-card' : k === 'title' ? 'h3' : t('src.optional') });
    i.dataset.key = k;
    return el('label', { class: 'field' }, `${k}${k === 'item' || k === 'title' ? ' *' : ''}`, i);
  });
  const selectors = el('div', {}, el('div', { class: 'muted', style: 'margin:8px 0 4px;font-size:12px' }, t('src.selectors')), el('div', { class: 'selectors' }, selFields));
  const sync = () => {
    const a = S.adapters[type.value];
    hint.textContent = (getLang() === 'en' ? a?.hintEn : a?.hint) ?? '';
    selectors.classList.toggle('hidden', type.value !== 'html');
  };
  type.addEventListener('change', sync);
  sync();

  const submit = async () => {
    const body = {
      name: name.value,
      type: type.value,
      maxPages: Number(pages.value),
      urls: urls.value.split('\n').map((x) => x.trim()).filter(Boolean),
      selectors:
        type.value === 'html' ? Object.fromEntries(selFields.map((f) => f.querySelector('input')).map((i) => [i.dataset.key, i.value.trim()])) : undefined,
    };
    try {
      if (isNewSrc) {
        applyState(await api('/api/sources', { method: 'POST', body: { ...body, enabled: true } }));
        toast(t('src.added'));
      } else {
        await saveSource(s, { ...s, ...body }, true);
      }
      S.editingSource = null;
      renderSources();
    } catch (e) {
      toast(tr(e.message), 4000);
    }
  };

  return el(
    'div',
    { class: 'panel source-form form' },
    el('h3', { style: 'margin-top:0' }, isNewSrc ? t('src.new') : t('src.editTitle', tr(s.name))),
    el('div', { class: 'grid' }, el('label', { class: 'field' }, t('src.name'), name), el('label', { class: 'field' }, t('src.type'), type), el('label', { class: 'field' }, t('src.maxPages'), pages)),
    hint,
    el('label', { class: 'field' }, t('src.urls'), urls),
    selectors,
    el(
      'div',
      { class: 'row end' },
      el('button', { class: 'btn ghost', onclick: () => ((S.editingSource = null), renderSources()) }, t('src.cancel')),
      el('button', { class: 'btn primary', onclick: submit }, t('src.save')),
    ),
  );
}

$('#btn-add-source').addEventListener('click', () => {
  S.editingSource = 'new';
  renderSources();
});

async function saveSource(s, next, throwErr = false) {
  try {
    applyState(await api(`/api/sources/${encodeURIComponent(s.id)}`, { method: 'PUT', body: next }));
    toast(t('src.saved'));
    renderSources();
  } catch (e) {
    if (throwErr) throw e;
    toast(tr(e.message));
  }
}
async function deleteSource(s) {
  if (!confirm(t('src.confirmDelete', tr(s.name)))) return;
  try {
    applyState(await api(`/api/sources/${encodeURIComponent(s.id)}`, { method: 'DELETE', body: {} }));
    await loadJobs();
    renderSources();
  } catch (e) {
    toast(tr(e.message));
  }
}
async function scanOne(s) {
  try {
    await api('/api/scan', { method: 'POST', body: { sourceId: s.id } });
    S.scan.running = true;
    renderScanStatus();
    toast(t('src.scanning', tr(s.name)));
  } catch (e) {
    toast(tr(e.message));
  }
}

function applyState(st) {
  S.config = st.config;
  S.scan = st.scan;
  renderScanStatus();
}

// ------------------------------------------------------------------ profile view
function tagEditor(key, label, help, values) {
  const tags = [...values];
  const box = el('div', { class: 'tag-box' });
  const input = el('input', { type: 'text', placeholder: t('prof.tagPh'), list: 'tech-list' });
  const draw = () =>
    box.replaceChildren(
      ...tags.map((tag, i) =>
        el('span', { class: 'tag' }, tag, el('button', { title: t('prof.remove'), onclick: () => (tags.splice(i, 1), draw()) }, '×')),
      ),
      input,
    );
  const add = () => {
    for (const v of input.value.split(',').map((x) => x.trim()).filter(Boolean)) if (!tags.some((tag) => tag.toLowerCase() === v.toLowerCase())) tags.push(v);
    input.value = '';
    draw();
    input.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      draw();
    }
  });
  input.addEventListener('blur', () => input.value && add());
  draw();
  const node = el('div', { class: `tag-editor ${key}` }, el('div', { class: 'label' }, label, ' ', el('span', { class: 'muted' }, help)), box);
  node.getTags = () => tags;
  node.addTags = (list) => {
    for (const v of list) if (!tags.some((tag) => tag.toLowerCase() === v.toLowerCase())) tags.push(v);
    draw();
  };
  return node;
}

const editors = {};
function renderProfile(drafts) {
  const p = drafts ?? S.config.profile;
  const dl = el('datalist', { id: 'tech-list' }, S.knownTech.map((tag) => el('option', { value: tag })));
  editors.core = tagEditor('core', t('prof.core'), t('prof.core.help'), p.core);
  editors.strong = tagEditor('strong', t('prof.strong'), '(×2)', p.strong);
  editors.familiar = tagEditor('familiar', t('prof.familiar'), '(×1)', p.familiar);
  editors.avoid = tagEditor('avoid', t('prof.avoid'), t('prof.avoid.help'), p.avoid);
  $('#profile-editors').replaceChildren(dl, editors.core, editors.strong, editors.familiar, editors.avoid);
  renderFiltersForm();
  renderSettingsForm();
}

$('#btn-save-profile').addEventListener('click', async () => {
  try {
    const body = Object.fromEntries(Object.entries(editors).map(([k, e]) => [k, e.getTags()]));
    applyState(await api('/api/profile', { method: 'PUT', body }));
    await loadJobs();
    toast(t('prof.saved'));
  } catch (e) {
    toast(tr(e.message));
  }
});

$('#btn-import').addEventListener('click', async () => {
  let tags;
  try {
    ({ tags } = await api('/api/profile/import', { method: 'POST', body: { text: $('#import-text').value } }));
  } catch (e) {
    return toast(tr(e.message));
  }
  const have = new Set(Object.values(editors).flatMap((e) => e.getTags().map((tag) => tag.toLowerCase())));
  const fresh = tags.filter((tag) => !have.has(tag.toLowerCase()));
  const out = $('#import-result');
  if (!tags.length) return out.replaceChildren(el('p', { class: 'muted' }, t('prof.importNone')));
  out.replaceChildren(
    el('div', { class: 'chips' }, tags.map((tag) => el('span', { class: `chip ${fresh.includes(tag) ? '' : 'match'}` }, tag))),
    fresh.length
      ? el(
          'div',
          { class: 'row' },
          t('prof.importNew', fresh.length),
          el('button', { class: 'btn small', onclick: () => editors.strong.addTags(fresh) }, t('prof.addStrong')),
          el('button', { class: 'btn small', onclick: () => editors.familiar.addTags(fresh) }, t('prof.addFamiliar')),
          el('span', { class: 'muted' }, t('prof.thenSave')),
        )
      : el('p', { class: 'muted' }, t('prof.allKnown')),
  );
});

function linesField(label, help, values) {
  const area = el('textarea', { rows: Math.min(8, Math.max(3, values.length)) });
  area.value = values.join('\n');
  area.getLines = () => area.value.split('\n').map((x) => x.trim()).filter(Boolean);
  return [el('label', { class: 'field' }, label, el('span', { class: 'muted' }, help), area), area];
}

function renderFiltersForm() {
  const f = S.config.filters;
  const minSal = el('input', { type: 'number', min: 0, step: 5000, value: f.minSalaryCzkMonth });
  const hideUnknown = el('input', { type: 'checkbox', checked: f.hideUnknownSalary });
  const [cityL, city] = linesField(t('flt.cities'), t('flt.cities.help'), f.onsiteCities);
  const [incL, inc] = linesField(t('flt.include'), '', f.titleInclude);
  const [genL, gen] = linesField(t('flt.generic'), t('flt.generic.help'), f.titleGeneric);
  const [excL, exc] = linesField(t('flt.exclude'), '', f.titleExclude);
  const [allowL, allow] = linesField(t('flt.allowed'), t('flt.allowed.help'), f.remoteAllowed);
  const [blockL, block] = linesField(t('flt.blocked'), '', f.remoteBlocked);
  const form = $('#filters-form');
  form.replaceChildren(
    el('label', { class: 'field' }, t('flt.minSalary'), el('span', { class: 'muted' }, t('flt.minSalary.help')), minSal),
    el('label', { class: 'check' }, hideUnknown, t('flt.hideUnknown')),
    cityL,
    incL,
    genL,
    excL,
    allowL,
    blockL,
    el(
      'div',
      { class: 'row end' },
      el(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          onclick: async () => {
            if (!confirm(t('flt.confirmDefaults'))) return;
            applyState(await api('/api/defaults/filters', { method: 'POST', body: {} }));
            await loadJobs();
            renderFiltersForm();
          },
        },
        t('flt.defaults'),
      ),
      el('button', { type: 'submit', class: 'btn primary' }, t('flt.save')),
    ),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      applyState(
        await api('/api/filters', {
          method: 'PUT',
          body: {
            minSalaryCzkMonth: Number(minSal.value),
            hideUnknownSalary: hideUnknown.checked,
            onsiteCities: city.getLines(),
            titleInclude: inc.getLines(),
            titleGeneric: gen.getLines(),
            titleExclude: exc.getLines(),
            remoteAllowed: allow.getLines(),
            remoteBlocked: block.getLines(),
          },
        }),
      );
      await loadJobs();
      toast(t('flt.saved'));
    } catch (err) {
      toast(tr(err.message), 4000);
    }
  };
}

function renderSettingsForm() {
  const s = S.config.settings;
  const interval = el('input', { type: 'number', min: 5, max: 1440, value: s.scanIntervalMinutes });
  const details = el('input', { type: 'number', min: 0, max: 500, value: s.maxDetailFetchesPerScan });
  const gone = el('input', { type: 'number', min: 1, max: 1440, value: s.goneAfterHours });
  const enrichN = el('input', { type: 'number', min: 0, max: 500, value: s.maxEnrichPerScan ?? 0 });
  const notif = el('input', { type: 'checkbox', checked: s.notifications });
  const open = el('input', { type: 'checkbox', checked: s.openBrowser });
  const form = $('#settings-form');
  form.replaceChildren(
    el('label', { class: 'field' }, t('set.interval'), interval),
    el('label', { class: 'field' }, t('set.details'), el('span', { class: 'muted' }, t('set.details.help')), details),
    el('label', { class: 'field' }, t('set.gone'), gone),
    el('label', { class: 'field' }, t('set.enrich'), el('span', { class: 'muted' }, t('set.enrich.help')), enrichN),
    el('label', { class: 'check' }, notif, t('set.notify')),
    el('label', { class: 'check' }, open, t('set.open')),
    el('div', { class: 'row end' }, el('button', { type: 'submit', class: 'btn primary' }, t('set.save'))),
  );
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      applyState(
        await api('/api/settings', {
          method: 'PUT',
          body: {
            scanIntervalMinutes: Number(interval.value),
            maxDetailFetchesPerScan: Number(details.value),
            goneAfterHours: Number(gone.value),
            maxEnrichPerScan: Number(enrichN.value),
            notifications: notif.checked,
            openBrowser: open.checked,
          },
        }),
      );
      toast(t('set.saved'));
    } catch (err) {
      toast(tr(err.message), 4000);
    }
  };
}

// ------------------------------------------------------------------ live updates
function connectEvents() {
  const es = new EventSource('/api/events');
  let reloadTimer = null;
  const refresh = async (jobsToo) => {
    await loadState();
    if (!$('#view-sources').classList.contains('hidden') && !S.editingSource) renderSources();
    if (jobsToo) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadJobs, 400);
    }
  };
  es.addEventListener('scan-start', () => refresh(false));
  es.addEventListener('enriched', () => refresh(true));
  es.addEventListener('source', () => refresh(true)); // jobs arrive progressively as each source finishes
  es.addEventListener('scan-end', async (e) => {
    await refresh(true);
    const { newMatches } = JSON.parse(e.data || '{}');
    toast(newMatches ? t('scan.done.new', n('offers', newMatches)) : t('scan.done.none'));
  });
  es.onerror = () => {
    /* EventSource reconnects automatically */
  };
}

// ------------------------------------------------------------------ boot
(async () => {
  applyLanguage(getLang());
  try {
    await loadState();
    bindFilters();
    await loadJobs();
    const fromHash = location.hash.slice(1);
    showTab(['jobs', 'sources', 'profile'].includes(fromHash) ? fromHash : (prefs.tab ?? 'jobs'));
    connectEvents();
    setInterval(renderScanStatus, 30_000); // refresh the relative "… min ago" labels
  } catch (e) {
    document.body.append(el('div', { class: 'empty' }, t('boot.fail', tr(e.message))));
  }
})();
