import * as cheerio from 'cheerio';
import { fetchText, withParam } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob } from '../types.ts';
import { absUrl, clean, modeFromText, stripQuery } from './util.ts';

const MONEY_RE = /(kč|czk|eur|€|\$)/i;

// ---------------------------------------------------------------- jobs.cz
export async function listJobsCz(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const html = await fetchText(page === 1 ? url : withParam(url, 'page', page));
    const $ = cheerio.load(html);
    const cards = $('article.SearchResultCard');
    cards.each((_, el) => {
      const c = $(el);
      const a = c.find('a.SearchResultCard__titleLink').first();
      const id = a.attr('data-jobad-id');
      if (!id) return;
      const footer = c.find('.SearchResultCard__footerItem').map((_, e) => clean($(e).text())).get();
      const tags = c.find('.Tag').map((_, e) => clean($(e).text())).get();
      const salaryText = tags.find((t) => MONEY_RE.test(t) && /\d/.test(t));
      out.push({
        sourceJobId: id,
        url: stripQuery(absUrl(a.attr('href'), url)),
        title: clean(a.text()),
        company: footer[0],
        location: footer[1],
        salaryText,
        salary: parseSalary(salaryText, 'CZK'),
        tags: tags.filter((t) => t !== salaryText),
        workMode: modeFromText(tags.join(' ')),
      });
    });
    if (cards.length < 10) break; // last page
  }
  return out;
}

// ---------------------------------------------------------------- prace.cz
// Class names are CSS-module hashed (e.g. "ki5xOq_JobCard"), so match on the suffix.
export async function listPraceCz(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const $ = cheerio.load(await fetchText(page === 1 ? url : withParam(url, 'page', page)));
    const cards = $('[class*="_JobCard "], [class$="_JobCard"]');
    cards.each((_, el) => {
      const c = $(el);
      const titleEl = c.find('[class*="_JobCardTitle"]').first();
      const a = titleEl.find('a').first().length ? titleEl.find('a').first() : c.find('a').first();
      const href = absUrl(a.attr('href'), url);
      const id = href.match(/nabidka\/([0-9a-f-]{20,})/)?.[1] ?? href.match(/\/(?:pd|rpd)\/(\d+)/)?.[1];
      if (!id) return;
      const body = clean(c.find('[class*="_JobCardBody"]').text());
      const field = (label: string) =>
        body.match(new RegExp(`${label}:\\s*(.*?)(?=Lokalita:|Název firmy:|Typ úvazku:|Plat:|Forma práce:|$)`))?.[1]?.trim();
      const salaryText = field('Plat');
      const all = clean(c.text());
      out.push({
        sourceJobId: id,
        url: href.includes('prace.cz') ? stripQuery(href) : href,
        title: clean(titleEl.text() || a.text()),
        company: field('Název firmy'),
        location: field('Lokalita'),
        salaryText,
        salary: parseSalary(salaryText, 'CZK'),
        workMode: modeFromText(all),
        tags: [field('Typ úvazku'), field('Forma práce')].filter((x): x is string => !!x),
      });
    });
    if (cards.length < 10) break;
  }
  return out;
}

// ---------------------------------------------------------------- profesia.cz
export async function listProfesia(url: string, maxPages: number): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const $ = cheerio.load(await fetchText(page === 1 ? url : withParam(url, 'page_num', page)));
    const rows = $('li.list-row');
    rows.each((_, el) => {
      const c = $(el);
      const a = c.find('h2 a').first();
      const href = a.attr('href');
      const id = a.attr('id')?.replace(/^offer/, '') ?? href?.match(/\/O(\d+)/)?.[1];
      if (!href || !id) return;
      const salaryText = clean(c.find('.label').text()) || undefined;
      const location = clean(c.find('.job-location').text());
      out.push({
        sourceJobId: id,
        url: stripQuery(absUrl(href, url)),
        title: clean(c.find('.title').first().text()),
        company: clean(c.find('.employer').text()),
        location,
        salaryText,
        salary: parseSalary(salaryText, 'CZK'),
        workMode: modeFromText(location),
      });
    });
    if (rows.length < 15) break;
  }
  return out;
}
