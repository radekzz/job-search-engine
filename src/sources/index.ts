import type { AdapterType, RawJob, SourceConfig } from '../types.ts';
import { listJobsCz, listPraceCz, listProfesia } from './czech.ts';
import { listHtml, listRss } from './generic.ts';
import { detailLinkedIn, listLinkedIn } from './linkedin.ts';
import { detailGreenhouse, detailSmartRecruiters, listAshby, listGreenhouse, listLever, listRecruitee, listSmartRecruiters } from './ats.ts';
import { listArc, listFrontendEngineers, listBulldog, listEuroTechJobs, listJooble, listJsonLd, listLandingJobs, listRemoteCom, listRemoteRocketship, listWorkingNomads } from './eu.ts';
import { listEasyPrace, listJobscontact, listJobstack, listJsGuru, listReactJobs, listStartupJobs } from './more.ts';
import { listNoFluffJobs } from './nofluffjobs.ts';
import { listArbeitnow, listHimalayas, listJobicy, listRemoteOk, listRemotive } from './remote.ts';
import { fetchDetailGeneric } from './util.ts';

export interface Adapter {
  label: string;
  hint: string;
  /** English UI variants (fall back to label / hint) */
  labelEn?: string;
  hintEn?: string;
  /** Does the listing already contain the full description? */
  hasDescription: boolean;
  list(url: string, source: SourceConfig): Promise<RawJob[]>;
  detail?(job: RawJob): Promise<Partial<RawJob>>;
}

const generic = (job: RawJob) => fetchDetailGeneric(job.url);

export const ADAPTERS: Record<AdapterType, Adapter> = {
  jobscz: {
    label: 'Jobs.cz',
    hint: 'URL výsledků hledání z jobs.cz (s filtry). Stránkování přes &page=N.',
    hintEn: 'Jobs.cz search result URL (with your filters). Paging via &page=N.',
    hasDescription: false,
    list: (url, s) => listJobsCz(url, s.maxPages),
    detail: generic,
  },
  pracecz: {
    label: 'Prace.cz',
    hint: 'URL výsledků hledání z prace.cz.',
    hintEn: 'Prace.cz search result URL.',
    hasDescription: false,
    list: (url, s) => listPraceCz(url, s.maxPages),
    detail: generic,
  },
  profesia: {
    label: 'Profesia.cz',
    hint: 'URL výsledků hledání z profesia.cz.',
    hintEn: 'Profesia.cz / .sk search result URL.',
    hasDescription: false,
    list: (url, s) => listProfesia(url, s.maxPages),
    detail: generic,
  },
  linkedin: {
    label: 'LinkedIn (guest API)',
    hint: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=…&location=…  (f_WT=2 remote, 3 hybrid; f_TPR=r604800 = poslední týden)',
    hintEn: 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=…&location=…  (f_WT=2 remote, 3 hybrid; f_TPR=r604800 = last week). Check LinkedIn\'s terms before enabling.',
    hasDescription: false,
    list: (url, s) => listLinkedIn(url, s.maxPages),
    detail: detailLinkedIn,
  },
  nofluffjobs: {
    label: 'No Fluff Jobs',
    hint: 'URL hledání z nofluffjobs.com/cz (např. /cz/React?criteria=city%3Dbrno,remote).',
    hintEn: 'nofluffjobs.com search URL (e.g. /cz/React?criteria=city%3Dbrno,remote).',
    hasDescription: false,
    list: (url, s) => listNoFluffJobs(url, s.maxPages),
    detail: generic,
  },
  remoteok: {
    label: 'Remote OK (API)',
    hint: 'https://remoteok.com/api?tag=react',
    hasDescription: true,
    list: (url) => listRemoteOk(url),
  },
  remotive: {
    label: 'Remotive (API)',
    hint: 'https://remotive.com/api/remote-jobs?category=software-dev&search=react',
    hasDescription: true,
    list: (url) => listRemotive(url),
  },
  himalayas: {
    label: 'Himalayas (API)',
    hint: 'https://himalayas.app/jobs/api/search?q=react',
    hasDescription: true,
    list: (url, s) => listHimalayas(url, s.maxPages),
  },
  jobicy: {
    label: 'Jobicy (API)',
    hint: 'https://jobicy.com/api/v2/remote-jobs?count=50&tag=react',
    hasDescription: true,
    list: (url) => listJobicy(url),
  },
  arbeitnow: {
    label: 'Arbeitnow (API)',
    hint: 'https://www.arbeitnow.com/api/job-board-api',
    hasDescription: true,
    list: (url, s) => listArbeitnow(url, s.maxPages),
  },
  startupjobs: {
    label: 'StartupJobs.cz (sitemap)',
    hint: 'https://www.startupjobs.cz/sitemap/offers.xml – výpis je renderovaný v prohlížeči, proto se bere sitemap všech nabídek a detaily (JSON-LD).',
    labelEn: 'StartupJobs.cz (sitemap)',
    hintEn: 'https://www.startupjobs.cz/sitemap/offers.xml – the listing is rendered in the browser, so the sitemap of all offers is used plus details (JSON-LD).',
    hasDescription: false,
    list: (url) => listStartupJobs(url),
    detail: generic,
  },
  jobstack: {
    label: 'Jobstack.it',
    hint: 'Kategorie, např. https://www.jobstack.it/it-jobs/react-developer (stránkování ?page=N).',
    hintEn: 'Category URL, e.g. https://www.jobstack.it/it-jobs/react-developer (paging ?page=N).',
    hasDescription: false,
    list: (url, s) => listJobstack(url, s.maxPages),
    detail: generic,
  },
  easyprace: {
    label: 'Easy-práce.cz',
    hint: 'SEO URL pozice, např. https://www.easy-prace.cz/react-vyvojar nebo /brno/javascript-vyvojar (stránkování /strana/N).',
    hintEn: 'Position SEO URL, e.g. https://www.easy-prace.cz/react-vyvojar or /brno/javascript-vyvojar (paging /strana/N).',
    hasDescription: false,
    list: (url, s) => listEasyPrace(url, s.maxPages),
    detail: generic,
  },
  jobscontact: {
    label: 'JobsContact.cz',
    hint: 'https://www.jobscontact.cz/prace?jobFilterFulltext%5B0%5D=react',
    hasDescription: false,
    list: (url, s) => listJobscontact(url, s.maxPages),
    detail: generic,
  },
  reactjobs: {
    label: 'ReactJobs.io',
    hint: 'https://reactjobs.io/',
    hasDescription: false,
    list: (url) => listReactJobs(url),
    detail: generic,
  },
  jsguru: {
    label: 'JS Guru Jobs',
    hint: 'https://jsgurujobs.com/jobs/react nebo https://jsgurujobs.com/jobs/react-native (stránkování ?page=N).',
    hintEn: 'https://jsgurujobs.com/jobs/react or https://jsgurujobs.com/jobs/react-native (paging ?page=N).',
    hasDescription: false,
    list: (url, s) => listJsGuru(url, s.maxPages),
    detail: generic,
  },
  greenhouse: {
    label: 'Greenhouse (ATS, 1 URL = 1 firma)',
    hint: 'https://job-boards.greenhouse.io/<firma> nebo https://boards-api.greenhouse.io/v1/boards/<firma>/jobs',
    labelEn: 'Greenhouse (ATS, 1 URL = 1 company)',
    hintEn: 'https://job-boards.greenhouse.io/<company> or https://boards-api.greenhouse.io/v1/boards/<company>/jobs',
    hasDescription: false,
    list: (url) => listGreenhouse(url),
    detail: detailGreenhouse,
  },
  lever: {
    label: 'Lever (ATS, 1 URL = 1 firma)',
    hint: 'https://jobs.lever.co/<firma> (EU instance: jobs.eu.lever.co)',
    labelEn: 'Lever (ATS, 1 URL = 1 company)',
    hintEn: 'https://jobs.lever.co/<company> (EU instance: jobs.eu.lever.co)',
    hasDescription: true,
    list: (url) => listLever(url),
  },
  ashby: {
    label: 'Ashby (ATS, 1 URL = 1 firma)',
    hint: 'https://jobs.ashbyhq.com/<firma>',
    labelEn: 'Ashby (ATS, 1 URL = 1 company)',
    hintEn: 'https://jobs.ashbyhq.com/<company>',
    hasDescription: true,
    list: (url) => listAshby(url),
  },
  smartrecruiters: {
    label: 'SmartRecruiters (ATS, 1 URL = 1 firma)',
    hint: 'https://jobs.smartrecruiters.com/<firma> (ID firmy je citlivé na velikost písmen)',
    labelEn: 'SmartRecruiters (ATS, 1 URL = 1 company)',
    hintEn: 'https://jobs.smartrecruiters.com/<company> (the company id is case-sensitive)',
    hasDescription: false,
    list: (url, s) => listSmartRecruiters(url, s.maxPages),
    detail: detailSmartRecruiters,
  },
  recruitee: {
    label: 'Recruitee (ATS, 1 URL = 1 firma)',
    hint: 'https://<firma>.recruitee.com/',
    labelEn: 'Recruitee (ATS, 1 URL = 1 company)',
    hintEn: 'https://<company>.recruitee.com/',
    hasDescription: true,
    list: (url) => listRecruitee(url),
  },
  jsonld: {
    label: 'Stránka s JSON-LD JobPosting (Djinni, …)',
    hint: 'Libovolná stránka se seznamem nabídek, která vkládá schema.org JobPosting (např. https://djinni.co/jobs/?primary_keyword=React+Native).',
    labelEn: 'Page with JSON-LD JobPosting (Djinni, …)',
    hintEn: 'Any listing page embedding schema.org JobPosting (e.g. https://djinni.co/jobs/?primary_keyword=React+Native).',
    hasDescription: true,
    list: (url, s) => listJsonLd(url, s.maxPages),
  },
  remoterocketship: {
    label: 'Remote Rocketship',
    hint: 'https://www.remoterocketship.com/?jobTitle=react',
    hasDescription: true,
    list: (url) => listRemoteRocketship(url),
  },
  remotecom: {
    label: 'Remote.com job board',
    hint: 'https://remote.com/jobs/all?query=react',
    hasDescription: false,
    list: (url) => listRemoteCom(url),
    detail: generic,
  },
  arc: {
    label: 'Arc.dev',
    hint: 'https://arc.dev/remote-jobs/react',
    hasDescription: false,
    list: (url) => listArc(url),
    detail: generic,
  },
  bulldog: {
    label: 'Bulldogjob.pl',
    hint: 'https://bulldogjob.pl/companies/jobs/s/skills,React',
    hasDescription: false,
    list: (url) => listBulldog(url),
    detail: generic,
  },
  eurotechjobs: {
    label: 'EuroTechJobs',
    hint: 'https://www.eurotechjobs.com/job_search/keyword/react',
    hasDescription: false,
    list: (url, s) => listEuroTechJobs(url, s.maxPages),
    detail: generic,
  },
  landingjobs: {
    label: 'Landing.jobs (API)',
    hint: 'https://landing.jobs/api/v1/jobs?limit=50',
    hasDescription: true,
    list: (url, s) => listLandingJobs(url, s.maxPages),
  },
  workingnomads: {
    label: 'Working Nomads (API)',
    hint: 'https://www.workingnomads.com/api/exposed_jobs/',
    hasDescription: true,
    list: (url) => listWorkingNomads(url),
  },
  jooble: {
    label: 'Jooble (oficiální API, vyžaduje JOOBLE_API_KEY)',
    hint: 'https://jooble.org/api/?keywords=react&location=Brno – klíč se bere z proměnné prostředí JOOBLE_API_KEY, nikdy z configu.',
    labelEn: 'Jooble (official API, needs JOOBLE_API_KEY)',
    hintEn: 'https://jooble.org/api/?keywords=react&location=Brno – the key is read from the JOOBLE_API_KEY environment variable, never from the config.',
    hasDescription: true,
    list: (url, s) => listJooble(url, s.maxPages),
  },
  frontendengineers: {
    label: 'FrontendEngineers.com',
    hint: 'Kategorie, např. https://www.frontendengineers.com/remote-react-jobs nebo /remote-frontend-jobs-europe (jen remote nabídky; detaily jsou placené, bere se jen veřejný výpis).',
    hintEn: 'Category URL, e.g. https://www.frontendengineers.com/remote-react-jobs or /remote-frontend-jobs-europe (remote only; details are paywalled, only the public listing is used).',
    hasDescription: false,
    list: (url) => listFrontendEngineers(url),
  },
  rss: {
    label: 'RSS / Atom feed',
    hint: 'Libovolný RSS/Atom feed s nabídkami (WeWorkRemotely, kariérní stránky firem…).',
    labelEn: 'RSS / Atom feed',
    hintEn: 'Any RSS/Atom feed with job offers (We Work Remotely, company career pages…).',
    hasDescription: true,
    list: (url) => listRss(url),
    detail: generic,
  },
  html: {
    label: 'Obecná HTML stránka (CSS selektory)',
    hint: 'Libovolná stránka se seznamem nabídek. Vyplň CSS selektory – item (karta nabídky) a title jsou povinné.',
    labelEn: 'Generic HTML page (CSS selectors)',
    hintEn: 'Any page with a list of offers. Fill in CSS selectors – item (offer card) and title are required.',
    hasDescription: false,
    list: (url, s) => listHtml(url, s.selectors),
    detail: generic,
  },
};
