import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';
import { fetchText } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { HtmlSelectors, RawJob } from '../types.ts';
import { absUrl, clean, htmlToText, modeFromText } from './util.ts';

const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

// ---------------------------------------------------------------- RSS / Atom
export async function listRss(url: string): Promise<RawJob[]> {
  const xml = await fetchText(url, { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } });
  const $ = cheerio.load(xml, { xml: true });
  const isWwr = new URL(url).host.includes('weworkremotely');
  const items = $('item').length ? $('item') : $('entry');
  return items
    .map((_, el) => {
      const c = $(el);
      let title = clean(c.find('title').first().text());
      let company: string | undefined;
      // WWR titles are "Company: Job title"
      if (isWwr && title.includes(': ')) [company, title] = [title.slice(0, title.indexOf(': ')), title.slice(title.indexOf(': ') + 2)];
      const link = clean(c.find('link').first().text()) || c.find('link').first().attr('href') || url;
      const description = htmlToText(c.find('description').first().text() || c.find('content').first().text());
      const region = clean(c.find('region').text());
      const country = clean(c.find('country').text());
      return {
        sourceJobId: clean(c.find('guid').text()) || clean(c.find('id').text()) || hash(link),
        url: link,
        title,
        company,
        location: [region, country].filter(Boolean).join(', ') || undefined,
        workMode: isWwr ? ('remote' as const) : modeFromText(`${title} ${region}`),
        description,
        postedAt: clean(c.find('pubDate').text()) || clean(c.find('updated').text()) || undefined,
        tags: c.find('category').map((_, e) => clean($(e).text())).get(),
      } satisfies RawJob;
    })
    .get();
}

// ---------------------------------------------------------------- HTML with user CSS selectors
export async function listHtml(url: string, sel: HtmlSelectors | undefined): Promise<RawJob[]> {
  if (!sel?.item || !sel.title) throw new Error('Zdroj typu html potřebuje selektory "item" a "title"');
  const $ = cheerio.load(await fetchText(url));
  return $(sel.item)
    .map((_, el): RawJob | undefined => {
      const c = $(el);
      const a = sel.link ? c.find(sel.link).first() : c.find('a[href]').first();
      const href = absUrl(a.attr('href') ?? c.attr('href'), url);
      const title = clean(c.find(sel.title).first().text());
      if (!title) return undefined;
      const salaryText = sel.salary ? clean(c.find(sel.salary).first().text()) || undefined : undefined;
      const location = sel.location ? clean(c.find(sel.location).first().text()) : undefined;
      return {
        sourceJobId: hash(href === url ? title : href),
        url: href,
        title,
        company: sel.company ? clean(c.find(sel.company).first().text()) : undefined,
        location,
        salaryText,
        salary: parseSalary(salaryText, 'CZK'),
        workMode: modeFromText(clean(c.text())),
      };
    })
    .get()
    .filter((j): j is RawJob => !!j);
}
