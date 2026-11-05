// Enrichment: find the offer on the employer's own careers site and contacts published there.
// Everything found is a heuristic → shown as "nutno ověřit". No guessing of personal e-mail addresses:
// only contacts literally published in the posting / on the careers page are kept.
import * as cheerio from 'cheerio';
import { fetchPage } from './http.ts';
import { clean, htmlToText } from './sources/util.ts';
import { normCompany, normTitle } from './store.ts';
import type { Contact, Enrichment, Job } from './types.ts';

// Job portals / aggregators – a link there is NOT the employer's original.
const PORTAL_HOST =
  /(^|\.)(linkedin\.com|jobs\.cz|prace\.cz|profesia\.(cz|sk)|startupjobs\.(cz|com)|nofluffjobs\.com|remoteok\.com|remotive\.com|weworkremotely\.com|himalayas\.app|jobicy\.com|arbeitnow\.(com|co\.uk)|jobstack\.it|easy-prace\.cz|jobscontact\.cz|reactjobs\.io|jsgurujobs\.com|djinni\.co|remoterocketship\.com|remote\.com|arc\.dev|bulldogjob\.pl|eurotechjobs\.com|landing\.jobs|workingnomads\.com|frontendengineers\.com|jooble\.org|indeed\.com|glassdoor\.com|welcometothejungle\.com|atmoskop\.cz|teamio\.com|grafton\.cz|hays\.cz)$/i;
// Applicant tracking systems – an employer-run board, i.e. official.
const ATS_HOST =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|recruitee\.com|workable\.com|teamtailor\.com|personio\.(de|com)|breezy\.hr|bamboohr\.com|recruitis\.io|jobs\.personio\.de|myworkdayjobs\.com|workday\.com|successfactors\.(com|eu)|icims\.com|jobvite\.com|join\.com)$/i;
const NOISE_HOST =
  /(^|\.)(facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|google\.[a-z.]+|goo\.gl|apple\.com|play\.google\.com|cloudflare\.com|gstatic\.com|googletagmanager\.com|cookiebot\.com|onetrust\.com|w3\.org|schema\.org|wikipedia\.org|github\.com|medium\.com|tiktok\.com|vimeo\.com|atmoskop\.cz)$/i;
// Recruitment agencies – contacts there are agency recruiters, not the employer.
const AGENCY_NAME =
  /(?<![\p{L}\d])(?:jobs contact|předvýběr|predvyber|grafton|hays|manpower(?:group)?|randstad|adecco|experis|lugera|antal international|michael page|page personnel|robert walters|hudson rpo|edwards & partners|index nosluš|proficio|cleverbee|jobote|kariera\.cz|lmc|personální agentura|personalni agentura|recruit(?:ment|ing|ers?)|staffing|headhunt(?:ers?|ing)?|talent partners|lemon\.io|toptal|proxify|andela|crossover)(?![\p{L}\d])/iu;
const AGENCY_TEXT =
  /pro našeho klienta|pro naseho klienta|for our client|on behalf of our client|our client is|náš klient|nas klient|personální agentur|recruitment agency|zprostředkování zaměstnání/i;

const MAX_FETCHES = 8; // per job – keeps a single enrichment cheap and polite

const host = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const baseDomain = (h: string) => h.split('.').slice(-2).join('.');
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Link shorteners and job aggregators – never the employer's original either.
const AGGREGATOR_HOST =
  /(^|\.)(bit\.ly|lnkd\.in|t\.co|tinyurl\.com|ow\.ly|buff\.ly|rebrand\.ly|dice\.com|jobgether\.com|builtin\.com|ziprecruiter\.com|talent\.com|simplyhired\.com|monster\.[a-z.]+|careerjet\.[a-z.]+|adzuna\.[a-z.]+|jobleads\.com|whatjobs\.com|getwork\.com|wellfound\.com|otta\.com|startup\.jobs|levels\.fyi|trueup\.io|jobrapido\.com|neuvoo\.[a-z.]+|recruit\.net)$/i;
const GENERIC_LABEL = /^(www|jobs?|careers?|kariera|career|apply|join|work|hr|en|cz|cs)$/;

export type LinkKind = 'ats' | 'microsite' | 'company' | 'external' | 'portal';

/**
 * ats/microsite/company = trustworthy as the employer's own posting.
 * "company" requires the host to carry the company name – any other domain is just "external".
 */
export function classifyUrl(url: string, company?: string): LinkKind {
  const h = host(url);
  if (!h) return 'portal';
  if (ATS_HOST.test(h)) return 'ats';
  // employer microsites on portal platforms (notino.jobs.cz), but not the portal's own sections
  if (/^(?!(www|firmy|m|beta|api|static|img|cdn|blog)\.)[a-z0-9-]+\.(jobs\.cz|prace\.cz)$/.test(h)) return 'microsite';
  if (PORTAL_HOST.test(h) || AGGREGATOR_HOST.test(h) || NOISE_HOST.test(h)) return 'portal';
  const slug = normCompany(company ?? '');
  if (slug.length >= 3) {
    const labels = fold(h).split('.').slice(0, -1).filter((l) => !GENERIC_LABEL.test(l));
    const compact = labels.join('').replace(/[^a-z0-9]/g, '');
    if (compact.includes(slug) || labels.some((l) => l.replace(/[^a-z0-9]/g, '').length >= 4 && slug.includes(l.replace(/[^a-z0-9]/g, ''))))
      return 'company';
  }
  return 'external';
}

export const isOfficialUrl = (url: string, company?: string) => ['ats', 'microsite', 'company'].includes(classifyUrl(url, company));
const notPortal = (url: string) => classifyUrl(url) !== 'portal';

function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normTitle(a).split(' ').filter((w) => w.length > 1));
  const tb = new Set(normTitle(b).split(' ').filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

// ---------------------------------------------------------------- contacts
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+|00)\s?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}|(?:\+|00)\s?\d{2,3}(?:[\s.-]?\d{2,4}){3,4}|(?<!\d)\d{3}\s\d{3}\s\d{3}(?!\d)/g;
const PLACEHOLDER_EMAIL = /^(jmeno|jmeno\.prijmeni|name|your|vas|vase|email|e-mail|user|john|jane|info@domain)|@(domena|domain|example|vasedomena|yourdomain|firma|company)\./i;
const JOB_MAILBOX = /^(hr|jobs?|kariera|career|careers|prace|nabor|recruit\w*|people|talent|hiring|apply|cv|zivotopis|personal\w*)@/i;
const GENERIC_MAILBOX = /^(info|office|kancelar|hello|ahoj|contact|kontakt|team|tym|mail|recepce|sekretariat)@/i;
const BAD_EMAIL = /^(no-?reply|noreply|donotreply|privacy|gdpr|dpo|abuse|webmaster|postmaster|unsubscribe|example|test|sentry|support@sentry)|@(example|sentry|wixpress|sentry-next|domain|email)\.|\.(png|jpe?g|gif|svg|webp)$/i;
const FREEMAIL = /@(gmail|seznam|email|centrum|volny|post|outlook|hotmail|yahoo|icloud|proton(mail)?)\./i;

/** strict = page not specific to this job (homepage, general careers page) → only job/generic mailboxes, no personal addresses or phones. */
export function extractContacts(text: string, source: string, companyDomain: string | undefined, agency: boolean, strict = false): Contact[] {
  const out: Contact[] = [];
  for (const raw of text.match(EMAIL_RE) ?? []) {
    const value = raw.toLowerCase().replace(/\.$/, '');
    if (BAD_EMAIL.test(value) || PLACEHOLDER_EMAIL.test(value)) continue;
    const d = value.split('@')[1];
    if (PORTAL_HOST.test(d) || AGENCY_NAME.test(d)) continue; // portal / agency mailbox
    const own = !!companyDomain && baseDomain(d) === baseDomain(companyDomain);
    if (agency && !own) continue;
    const box = JOB_MAILBOX.test(value) ? 'náborová schránka' : GENERIC_MAILBOX.test(value) ? 'obecná schránka' : FREEMAIL.test(value) ? 'soukromá schránka' : 'osobní adresa';
    if (strict && (box === 'osobní adresa' || box === 'soukromá schránka')) continue;
    out.push({ type: 'email', value, source, note: `nutno ověřit · ${box} · ${own ? 'doména firmy' : 'jiná doména'}` });
  }
  for (const raw of text.match(PHONE_RE) ?? []) {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 13 || /^(\d)\1+$/.test(digits) || /123456789|987654321/.test(digits)) continue;
    if (agency || strict) continue; // can't tell agency phone from employer phone / unrelated to this job
    out.push({ type: 'phone', value: clean(raw), source, note: 'nutno ověřit' });
  }
  return out;
}

// ---------------------------------------------------------------- page helpers
interface Page {
  url: string;
  $: cheerio.CheerioAPI;
  text: string;
}

async function load(url: string, budget: { left: number }): Promise<Page | undefined> {
  if (budget.left <= 0) return undefined;
  budget.left--;
  try {
    const res = await fetchPage(url, {}, 0);
    const $ = cheerio.load(res.text);
    $('script:not([type="application/ld+json"]),style,noscript,svg').remove();
    return { url: res.url, $, text: htmlToText($('body').html() ?? '', 30_000) };
  } catch {
    return undefined;
  }
}

function links($: cheerio.CheerioAPI, base: string): { href: string; text: string }[] {
  return $('a[href]')
    .map((_, a) => {
      try {
        return { href: new URL($(a).attr('href')!, base).toString(), text: clean($(a).text()) || clean($(a).attr('aria-label')) };
      } catch {
        return undefined;
      }
    })
    .get()
    .filter((l): l is { href: string; text: string } => !!l && /^https?:/.test(l.href));
}

function orgFromJsonLd($: cheerio.CheerioAPI): string | undefined {
  let site: string | undefined;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (site) return;
    try {
      const nodes = ([] as any[]).concat(JSON.parse($(el).text())).flatMap((n) => n?.['@graph'] ?? [n]);
      for (const n of nodes) {
        const org = n?.['@type'] === 'JobPosting' ? n.hiringOrganization : undefined;
        const cand = [org?.sameAs, org?.url].flat().find((u) => typeof u === 'string' && /^https?:/.test(u) && notPortal(u));
        if (cand) site = cand;
      }
    } catch {
      /* ignore */
    }
  });
  return site;
}

const CAREERS_LINK = /kari[eé]r|career|jobs?\b|pr[aá]ce|join[- ]?us|hiring|volná místa|volna-mista|pracovní příležitosti|open positions|work with us|pracuj s námi/i;
const APPLY_LINK = /apply|reagovat|odpov[eě]d[eě]t|p[rř]ihl[aá]sit|uch[aá]zet|zaslat životopis|application/i;

// ---------------------------------------------------------------- main
export async function enrichJob(job: Job): Promise<Enrichment> {
  const budget = { left: MAX_FETCHES };
  const method: string[] = [];
  const company = job.company ?? '';
  const slug = normCompany(company);
  const agency = AGENCY_NAME.test(company) || AGENCY_TEXT.test(job.description ?? '');
  const result: Enrichment = { at: new Date().toISOString(), status: 'not-found', method, contacts: [], agency };

  let originalUrl: string | undefined;
  let careersUrl: string | undefined;
  let companySite: string | undefined;
  const pages: Page[] = [];

  // 1) the listing itself is official (ATS / employer site / employer microsite)
  const allUrls = [job.url, ...(job.applyUrl ? [job.applyUrl] : []), ...job.links.map((l) => l.url)];
  const official = allUrls.find((u) => isOfficialUrl(u, company));
  if (official) {
    originalUrl = official;
    const kind = classifyUrl(official, company);
    method.push(kind === 'ats' ? 'ATS firmy' : kind === 'microsite' ? 'kariérní microsite firmy' : 'odkaz vede na doménu firmy');
  } else {
    // a non-portal link we can't tie to the employer (unknown domain) – shown, but not as the original
    result.externalUrl = allUrls.find((u) => classifyUrl(u, company) === 'external');
  }

  // 2) portal detail page → apply link / employer site from JSON-LD / links to employer domain
  if (!originalUrl && !agency) {
    const page = await load(job.url, budget);
    if (page) {
      pages.push(page);
      // e.g. jobs.cz/rpd/… redirects to the employer microsite (uniqa.jobs.cz/…)
      if (host(page.url) !== host(job.url) && isOfficialUrl(page.url, company)) {
        originalUrl = page.url;
        method.push('portál přesměroval na kariérní web firmy');
      }
      const ld = orgFromJsonLd(page.$);
      if (ld) {
        companySite = new URL(ld).origin;
        method.push('web firmy z JSON-LD portálu');
      }
      const ext = links(page.$, page.url).filter((l) => notPortal(l.href));
      const applyLinks = ext.filter((l) => APPLY_LINK.test(l.text) || (ATS_HOST.test(host(l.href)) && /\/(jobs?|o|postings?)\/|[?&](gh_jid|jobId)=/i.test(l.href)));
      const apply = originalUrl ? undefined : applyLinks.find((l) => isOfficialUrl(l.href, company));
      if (apply) {
        originalUrl = apply.href.replace(/[?&](ref|utm_[a-z]+)=[^&]*/g, '');
        method.push('odkaz „Apply" na portálu');
      } else if (!originalUrl && !result.externalUrl) {
        result.externalUrl = applyLinks[0]?.href;
      }
      if (!companySite) {
        const own = ext.find((l) => classifyUrl(l.href, company) === 'company');
        if (own) {
          companySite = new URL(own.href).origin;
          method.push('odkaz na web firmy z portálu');
        }
      }
    }
  }

  // 3) still no employer site → guess the domain from the company name, verified by the homepage
  if (!originalUrl && !companySite && !agency && slug.length >= 3) {
    const fullName = fold(company).replace(/[^a-z0-9]/g, '');
    for (const tld of ['cz', 'com', 'io', 'eu']) {
      const cand = `https://www.${slug}.${tld}/`;
      const page = await load(cand, budget);
      if (!page || classifyUrl(page.url, company) !== 'company') continue; // redirected elsewhere
      const brand = fold(`${page.$('title').text()} ${page.$('meta[property="og:site_name"]').attr('content') ?? ''}`).replace(/[^a-z0-9]/g, '');
      // whole slug in the site title; short/generic slugs ("smart") need the full company name
      if (brand.includes(slug) && (slug.length >= 5 || brand.includes(fullName))) {
        companySite = new URL(page.url).origin;
        pages.push(page);
        method.push(`odhad domény ${host(cand)} (ověřeno titulkem webu)`);
        break;
      }
    }
  }

  // 4) employer site → careers page → the same job title
  if (!originalUrl && companySite) {
    const home = pages.find((p) => p.url.startsWith(companySite!)) ?? (await load(`${companySite}/`, budget));
    if (home) {
      const cand = links(home.$, home.url).filter(
        (l) => CAREERS_LINK.test(`${l.text} ${new URL(l.href).pathname}`) && (baseDomain(host(l.href)) === baseDomain(host(companySite!)) || ATS_HOST.test(host(l.href))),
      );
      let careers: { href: string; text: string } | undefined = cand[0];
      if (!careers) {
        // menu rendered by JS → try the usual paths
        const base = baseDomain(host(companySite));
        const guesses = [
          `https://kariera.${base}/`,
          `https://careers.${base}/`,
          `https://jobs.${base}/`,
          ...(slug.length >= 3 ? [`https://${slug}.jobs.cz/`] : []),
          ...['/kariera', '/careers', '/jobs'].map((p) => `${companySite}${p}`),
        ];
        for (const g of guesses) {
          if (budget.left <= 1) break;
          const p = await load(g, budget);
          // must still be the employer after redirects (not a portal homepage / parked domain)
          if (p && isOfficialUrl(p.url, company) && CAREERS_LINK.test(`${p.url} ${p.$('title').text()} ${p.$('h1').first().text()}`)) {
            careers = { href: p.url, text: g };
            pages.push(p);
            break;
          }
        }
      }
      if (careers) {
        careersUrl = careers.href;
        method.push('kariérní stránka z webu firmy');
        const cp = pages.find((p) => p.url === careers!.href) ?? (await load(careers.href, budget));
        if (cp) {
          pages.push(cp);
          const best = links(cp.$, cp.url)
            .filter((l) => notPortal(l.href))
            .map((l) => ({ ...l, score: titleSimilarity(l.text, job.title) }))
            .sort((a, b) => b.score - a.score)[0];
          if (best && best.score >= 0.75) {
            originalUrl = best.href;
            method.push(`nabídka na kariérní stránce (shoda názvu ${Math.round(best.score * 100)} %)`);
          } else {
            // careers page may embed an ATS board – follow it once
            const ats = links(cp.$, cp.url).find((l) => ATS_HOST.test(host(l.href)));
            if (ats) {
              const ap = await load(ats.href, budget);
              const hit = ap && links(ap.$, ap.url).map((l) => ({ ...l, score: titleSimilarity(l.text, job.title) })).sort((a, b) => b.score - a.score)[0];
              if (hit && hit.score >= 0.75) {
                originalUrl = hit.href;
                method.push('nabídka v ATS firmy (z kariérní stránky)');
              } else careersUrl = ats.href;
            }
          }
        }
      }
    }
  }

  // 5) contacts – job description + the original page (if we have / can afford it)
  if (originalUrl && !pages.some((p) => p.url === originalUrl)) {
    const op = await load(originalUrl, budget);
    if (op) pages.push(op);
  }
  const companyDomain = companySite ? host(companySite) : originalUrl && !ATS_HOST.test(host(originalUrl)) ? host(originalUrl) : undefined;
  const contacts = [
    ...extractContacts(job.description ?? '', 'popis nabídky', companyDomain, agency),
    ...pages
      .filter((p) => notPortal(p.url) || classifyUrl(p.url) === 'microsite')
      .flatMap((p) => extractContacts(p.text, p.url, companyDomain, agency, p.url !== originalUrl)),
  ];
  const seen = new Set<string>();
  // job mailboxes > generic mailboxes > personal; posting itself before the rest of the website; max 2 phones
  const rank = (c: Contact) =>
    (c.type === 'phone' ? 3 : /náborová/.test(c.note) ? 0 : /obecná/.test(c.note) ? 1 : 2) + (c.source === 'popis nabídky' || c.source === originalUrl ? 0 : 0.5);
  const unique = contacts.filter((c) => !seen.has(c.value) && seen.add(c.value)).sort((a, b) => rank(a) - rank(b));
  result.contacts = [...unique.filter((c) => c.type === 'email').slice(0, 4), ...unique.filter((c) => c.type === 'phone').slice(0, 2)];

  result.originalUrl = originalUrl;
  result.careersUrl = careersUrl;
  result.companySite = companySite;
  result.status = agency && !originalUrl ? 'agency' : originalUrl ? 'found-original' : careersUrl ? 'careers-only' : 'not-found';
  return result;
}
