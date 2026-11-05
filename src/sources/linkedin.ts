import * as cheerio from 'cheerio';
import { fetchText, withParam } from '../http.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob, WorkMode } from '../types.ts';
import { clean, htmlToText, stripQuery } from './util.ts';

// LinkedIn "guest" endpoints – the same ones the public (logged-out) job search uses.
// No login needed, but LinkedIn rate-limits aggressively (HTTP 429), hence few pages + big gaps.

export async function listLinkedIn(url: string, maxPages: number): Promise<RawJob[]> {
  const wt = new URL(url).searchParams.get('f_WT');
  const forcedMode: WorkMode | undefined = wt === '2' ? 'remote' : wt === '3' ? 'hybrid' : wt === '1' ? 'onsite' : undefined;
  const out: RawJob[] = [];
  for (let page = 0; page < maxPages; page++) {
    const html = await fetchText(page === 0 ? url : withParam(url, 'start', page * 10));
    const $ = cheerio.load(html);
    const cards = $('li');
    cards.each((_, el) => {
      const c = $(el);
      const urn = c.find('[data-entity-urn]').attr('data-entity-urn');
      const id = urn?.split(':').pop();
      const link = c.find('a.base-card__full-link').attr('href');
      if (!id || !link) return;
      const salaryText = clean(c.find('.job-search-card__salary-info').text()) || undefined;
      out.push({
        sourceJobId: id,
        url: stripQuery(link),
        title: clean(c.find('.base-search-card__title').text()),
        company: clean(c.find('.base-search-card__subtitle').text()),
        location: clean(c.find('.job-search-card__location').text()),
        postedAt: c.find('time').attr('datetime'),
        salaryText,
        salary: parseSalary(salaryText),
        workMode: forcedMode,
      });
    });
    if (cards.length < 10) break;
  }
  return out;
}

export async function detailLinkedIn(job: RawJob): Promise<Partial<RawJob>> {
  const html = await fetchText(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${job.sourceJobId}`);
  const $ = cheerio.load(html);
  const description = htmlToText($('.show-more-less-html__markup').html());
  const salaryText = clean($('.compensation__salary').first().text()) || undefined;
  const criteria = $('.description__job-criteria-text').map((_, e) => clean($(e).text())).get();
  return {
    description,
    ...(salaryText ? { salaryText, salary: parseSalary(salaryText) } : {}),
    tags: criteria.filter((c) => c && c !== 'Not Applicable'),
  };
}
