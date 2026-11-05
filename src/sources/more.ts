// StartupJobs, jobstack.it, easy-prace.cz, jobscontact.cz, reactjobs.io, jsgurujobs.com
import * as cheerio from 'cheerio';
import { fetchText, withParam } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob } from '../types.ts';
import { absUrl, clean, modeFromText, stripQuery } from './util.ts';

const MONEY_RE = /(kč|czk|eur|€|\$|usd|£|gbp|pln|zł|chf)/i;

// ---------------------------------------------------------------- startupjobs.cz
// Listing is client-rendered from a non-public API, but the offers sitemap lists every active
// offer (/nabidka/<id>/<slug>). The slug is used as a provisional title for relevance filtering;
// real title/company/location/salary come from the detail's JSON-LD JobPosting.
export async function listStartupJobs(url: string): Promise<RawJob[]> {
  const $ = cheerio.load(await fetchText(url, { headers: { Accept: 'application/xml, text/xml' } }), { xml: true });
  return $('url')
    .map((_, el): RawJob | undefined => {
      const loc = clean($(el).find('loc').text());
      const m = loc.match(/\/nabidka\/(\d+)\/([^/?#]+)/);
      if (!m) return undefined;
      return {
        sourceJobId: m[1],
        url: loc,
        title: m[2].replace(/-/g, ' '),
        postedAt: clean($(el).find('lastmod').text()) || undefined,
        provisional: true,
      };
    })
    .get()
    .filter((j): j is RawJob => !!j);
}

// ---------------------------------------------------------------- jobstack.it
export async function listJobstack(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const $ = cheerio.load(await fetchText(page === 1 ? url : withParam(url, 'page', page)));
    const cards = $('li.jobposts-item');
    cards.each((_, el) => {
      const c = $(el);
      const href = c.find('a[href*="/it-job/"]').first().attr('href');
      const id = href?.match(/\/it-job\/[^/]+\/([0-9a-f]+)/)?.[1];
      if (!href || !id) return;
      const labels = c.find('.custom-profile-label').map((_, e) => clean($(e).text())).get();
      // company + location are the unclassed spans in the card footer
      const [company, location] = c
        .find('span:not([class])')
        .map((_, e) => clean($(e).text()))
        .get()
        .filter(Boolean);
      const salaryText = clean(c.find('.jobposts-item_salary').text()) || undefined;
      out.push({
        sourceJobId: id,
        url: absUrl(href, url),
        title: clean(c.find('h3').first().text()),
        company,
        location,
        salaryText,
        salary: parseSalary(salaryText, 'CZK'),
        tags: labels,
        workMode: modeFromText(labels.join(' ')),
      });
    });
    if (cards.length < 20) break;
  }
  return out;
}

// ---------------------------------------------------------------- easy-prace.cz
// Search URLs are SEO paths: /react-vyvojar, /brno/javascript-vyvojar; pages: /<path>/strana/N
export async function listEasyPrace(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(url);
    if (page > 1) u.pathname = `${u.pathname.replace(/\/$/, '')}/strana/${page}`;
    const $ = cheerio.load(await fetchText(u.toString()));
    const cards = $('a.NabidkaItem');
    cards.each((_, el) => {
      const c = $(el);
      const href = c.attr('href');
      const id = href?.match(/\/nabidka\/[^/]+\/(\d+)/)?.[1];
      if (!href || !id) return;
      const info = c.find('.NabidkaItem-infoItem').map((_, e) => clean($(e).text())).get();
      const location = clean(c.find('.NabidkaItem-infoItem.is-locality').text()) || info[0];
      const labels = c.find('.NabidkaItem-labelValue').map((_, e) => clean($(e).text())).get();
      const salaryText = labels.find((l) => MONEY_RE.test(l) && /\d/.test(l));
      const title = clean(c.find('.NabidkaItem-title').text());
      out.push({
        sourceJobId: id,
        url: stripQuery(absUrl(href, url)),
        title,
        company: info.find((i) => i !== location && !/úvazek|brigád/i.test(i)),
        location,
        salaryText,
        salary: parseSalary(salaryText, 'CZK'),
        tags: [...info.slice(1), ...labels.filter((l) => l !== salaryText)],
        workMode: modeFromText(`${title} ${labels.join(' ')}`),
      });
    });
    if (cards.length < 40) break;
  }
  return out;
}

// ---------------------------------------------------------------- jobscontact.cz
// Search: /prace?jobFilterFulltext[0]=react (fulltext also hits descriptions – title filter sorts it out)
export async function listJobscontact(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const pageUrl = page === 1 ? url : withParam(withParam(url, 'do', 'visualPaginator-showPage'), 'page', page);
    const $ = cheerio.load(await fetchText(pageUrl));
    const cards = $('div.job-box');
    cards.each((_, el) => {
      const c = $(el);
      const href = c.find('a.job-box-left').attr('href') ?? c.find('a[href*="_id"]').first().attr('href');
      const id = href?.match(/_id(\d+)/)?.[1];
      if (!href || !id) return;
      const salaryText = clean(c.find('.pay').text());
      const title = clean(c.find('h2').first().text());
      const snippet = clean(c.find('a.job-box-left > p').last().text());
      out.push({
        sourceJobId: id,
        url: stripQuery(absUrl(href, url)),
        title,
        // same name as on easy-prace.cz (they cross-post) so dedup merges them
        company: 'Jobs Contact Personal',
        location: clean(c.find('.place').text()) || undefined,
        salaryText: /\d/.test(salaryText) ? salaryText : undefined,
        salary: /\d/.test(salaryText) ? parseSalary(salaryText, 'CZK') : undefined,
        description: snippet || undefined,
        tags: c.find('.best-ico > div').map((_, e) => clean($(e).text())).get(),
        workMode: modeFromText(title),
      });
    });
    if (cards.length < 10) break;
  }
  return out;
}

// ---------------------------------------------------------------- reactjobs.io
export async function listReactJobs(url: string): Promise<RawJob[]> {
  const $ = cheerio.load(await fetchText(url));
  const out = new Map<string, RawJob>();
  $('a[href*="/react-jobs/"]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const id = href.match(/\/react-jobs\/[^/]+\/(\d+)-/)?.[1];
    if (!id || out.has(id)) return;
    const card = $(a).closest('li');
    const field = (name: string) => clean(card.find('dt').filter((_, d) => clean($(d).text()) === name).next('dd').text()) || undefined;
    const title = field('Title') ?? clean($(a).text());
    const location = field('Location');
    const salaryText = field('Salary');
    // the card also links straight to the employer's ATS (…?ref=reactjobs.io)
    const external = card
      .find('a[href^="http"]')
      .map((_, x) => $(x).attr('href')!)
      .get()
      .find((h) => !h.includes('reactjobs.io'));
    out.set(id, {
      applyUrl: external?.replace(/[?&]ref=reactjobs\.io/, ''),
      sourceJobId: id,
      url: stripQuery(absUrl(href, url)),
      title,
      company: field('Company'),
      location,
      salaryText,
      salary: parseSalary(salaryText, 'USD'),
      tags: [field('Employment Type')].filter((x): x is string => !!x),
      workMode: modeFromText(`${title} ${location ?? ''}`),
    });
  });
  return [...out.values()];
}

// ---------------------------------------------------------------- jsgurujobs.com
export async function listJsGuru(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const $ = cheerio.load(await fetchText(page === 1 ? url : withParam(url, 'page', page)));
    // listing uses <h3>, tag pages (/jobs/react) <h2>
    const anchors = $(':is(h2, h3) > a[href*="jsgurujobs.com/jobs/"]').filter((_, a) => /\/jobs\/\d+/.test($(a).attr('href') ?? ''));
    anchors.each((_, a) => {
      const href = $(a).attr('href')!;
      const card = $(a).closest('div.bg-white');
      const meta = card.find('div.mt-2').first().children('span').map((_, e) => clean($(e).text())).get();
      const badges = card.find('span.rounded').map((_, e) => clean($(e).text())).get();
      const salaryText = meta.find((m) => MONEY_RE.test(m) && /\d/.test(m));
      const remote = badges.some((b) => /remote/i.test(b)) || /worldwide|remote|anywhere|global/i.test(meta[0] ?? '');
      const region = badges.find((b) => /worldwide|europe|emea|americas|usa?\b|latam|asia/i.test(b));
      out.push({
        sourceJobId: href.match(/\/jobs\/(\d+)/)![1],
        url: href,
        title: clean($(a).text()),
        company: clean($(a).parent().parent().next('p').text()) || undefined,
        // e.g. "Germany (Remote · Worldwide)" – region badge decides remote eligibility
        location: remote ? [...new Set([region, meta[0]].filter(Boolean))].join(' · ') || 'Remote' : meta[0],
        salaryText,
        salary: parseSalary(salaryText, 'USD'),
        tags: [...meta.filter((m) => m !== salaryText && m !== meta[0]), ...badges],
        workMode: remote ? 'remote' : modeFromText(badges.join(' ')),
      });
    });
    if (anchors.length < 10) break;
  }
  return out;
}
