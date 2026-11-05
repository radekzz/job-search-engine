import { dataPath, readJson, writeJsonAtomic } from './fsutil.ts';
import { defaultLang, msg, setServerLang } from './i18n.ts';
import type { AppConfig, SourceConfig } from './types.ts';

const CONFIG_FILE = dataPath('config.json');
const CONFIG_VERSION = 1;

const li = (keywords: string, location: string, remoteOnly = false) =>
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?' +
  new URLSearchParams({
    keywords,
    location,
    f_TPR: 'r604800', // posted in the last 7 days
    ...(remoteOnly ? { f_WT: '2' } : {}),
  }).toString();

/** Source list with the react-native preset's search URLs; other presets override per source id. */
const BASE_SOURCES: SourceConfig[] = [
  {
    id: 'jobscz',
    name: 'Jobs.cz',
    type: 'jobscz',
    enabled: true,
    maxPages: 3,
    urls: [
      'https://www.jobs.cz/prace/brno/?q%5B%5D=react',
      'https://www.jobs.cz/prace/brno/?q%5B%5D=frontend',
      'https://www.jobs.cz/prace/?q%5B%5D=react%20native',
      'https://www.jobs.cz/prace/?q%5B%5D=react&q%5B%5D=remote',
    ],
  },
  {
    id: 'pracecz',
    name: 'Prace.cz',
    type: 'pracecz',
    enabled: true,
    maxPages: 2,
    urls: [
      'https://www.prace.cz/nabidky/brno/?q=react',
      'https://www.prace.cz/nabidky/brno/?q=frontend',
      'https://www.prace.cz/nabidky/?q=react%20native',
    ],
  },
  {
    id: 'profesia',
    name: 'Profesia.cz',
    type: 'profesia',
    enabled: true,
    maxPages: 1,
    urls: [
      'https://www.profesia.cz/prace/brno/?search_anywhere=react',
      'https://www.profesia.cz/prace/?search_anywhere=react%20native',
    ],
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    type: 'linkedin',
    // opt-in: LinkedIn's terms prohibit automated collection – enable at your own risk
    enabled: false,
    maxPages: 3,
    urls: [
      li('React Native', 'Brno, South Moravia, Czechia'),
      li('React', 'Brno, South Moravia, Czechia'),
      li('Frontend', 'Brno, South Moravia, Czechia'),
      li('React', 'Czechia', true),
      li('React Native', 'European Union', true),
      li('React Frontend', 'European Union', true),
      li('Tech Lead React', 'Czechia'),
    ],
  },
  {
    id: 'nofluffjobs',
    name: 'No Fluff Jobs',
    type: 'nofluffjobs',
    enabled: true,
    maxPages: 2,
    urls: [
      'https://nofluffjobs.com/cz/React?criteria=city%3Dbrno,remote',
      'https://nofluffjobs.com/cz/frontend?criteria=city%3Dbrno,remote',
      'https://nofluffjobs.com/cz/mobile?criteria=city%3Dbrno,remote',
    ],
  },
  {
    id: 'remoteok',
    name: 'Remote OK',
    type: 'remoteok',
    enabled: true,
    maxPages: 1,
    urls: ['https://remoteok.com/api?tag=react', 'https://remoteok.com/api?tag=react-native'],
  },
  {
    id: 'remotive',
    name: 'Remotive',
    type: 'remotive',
    enabled: true,
    maxPages: 1,
    urls: [
      'https://remotive.com/api/remote-jobs?category=software-dev&search=react',
      'https://remotive.com/api/remote-jobs?category=software-dev&search=react%20native',
    ],
  },
  {
    id: 'weworkremotely',
    name: 'We Work Remotely',
    type: 'rss',
    enabled: true,
    maxPages: 1,
    urls: ['https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss'],
  },
  {
    id: 'himalayas',
    name: 'Himalayas',
    type: 'himalayas',
    enabled: true,
    maxPages: 2,
    urls: [
      'https://himalayas.app/jobs/api/search?q=react%20native',
      'https://himalayas.app/jobs/api/search?q=react%20frontend',
    ],
  },
  {
    id: 'jobicy',
    name: 'Jobicy',
    type: 'jobicy',
    enabled: true,
    maxPages: 1,
    urls: ['https://jobicy.com/api/v2/remote-jobs?count=50&tag=react'],
  },
  {
    id: 'startupjobs',
    name: 'StartupJobs.cz',
    type: 'startupjobs',
    enabled: true,
    maxPages: 1,
    urls: ['https://www.startupjobs.cz/sitemap/offers.xml'],
  },
  {
    id: 'jobstack',
    name: 'Jobstack.it',
    type: 'jobstack',
    enabled: true,
    maxPages: 2,
    urls: [
      'https://www.jobstack.it/it-jobs/react-developer',
      'https://www.jobstack.it/it-jobs/javascript-developer',
      'https://www.jobstack.it/it-jobs/developer-mobilnich-aplikaci',
    ],
  },
  {
    id: 'easyprace',
    name: 'Easy-práce.cz',
    type: 'easyprace',
    enabled: true,
    maxPages: 2,
    urls: ['https://www.easy-prace.cz/react-vyvojar', 'https://www.easy-prace.cz/brno/javascript-vyvojar'],
  },
  {
    id: 'jobscontact',
    name: 'JobsContact.cz',
    type: 'jobscontact',
    enabled: true,
    maxPages: 2,
    urls: ['https://www.jobscontact.cz/prace?jobFilterFulltext%5B0%5D=react'],
  },
  {
    id: 'reactjobs',
    name: 'ReactJobs.io',
    type: 'reactjobs',
    enabled: true,
    maxPages: 1,
    urls: ['https://reactjobs.io/'],
  },
  {
    id: 'jsguru',
    name: 'JS Guru Jobs',
    type: 'jsguru',
    enabled: true,
    maxPages: 2,
    urls: ['https://jsgurujobs.com/jobs/react', 'https://jsgurujobs.com/jobs/react-native'],
  },
  {
    id: 'greenhouse',
    name: 'Greenhouse – kariérní stránky firem',
    type: 'greenhouse',
    enabled: true,
    maxPages: 1,
    urls: [
      'https://job-boards.greenhouse.io/gitlab',
      'https://job-boards.greenhouse.io/vercel',
      'https://job-boards.greenhouse.io/grafanalabs',
      'https://job-boards.greenhouse.io/elastic',
      'https://job-boards.greenhouse.io/contentful',
      'https://job-boards.greenhouse.io/getyourguide',
      'https://job-boards.greenhouse.io/n26',
      'https://job-boards.greenhouse.io/bitpanda',
      'https://job-boards.greenhouse.io/sumup',
      'https://job-boards.greenhouse.io/wolt',
      'https://job-boards.greenhouse.io/monzo',
      'https://job-boards.greenhouse.io/typeform',
      'https://job-boards.greenhouse.io/intercom',
      'https://job-boards.greenhouse.io/raisin',
      'https://job-boards.greenhouse.io/celonis',
      'https://job-boards.greenhouse.io/adyen',
      'https://job-boards.greenhouse.io/mongodb',
      'https://job-boards.greenhouse.io/cloudflare',
      'https://job-boards.greenhouse.io/datadog',
      'https://job-boards.greenhouse.io/figma',
      'https://job-boards.greenhouse.io/discord',
      'https://job-boards.greenhouse.io/duolingo',
      'https://job-boards.greenhouse.io/stripe',
      'https://job-boards.greenhouse.io/coinbase',
      'https://job-boards.greenhouse.io/emplifi',
      'https://job-boards.greenhouse.io/ysoft',
    ],
  },
  {
    id: 'ashby',
    name: 'Ashby – kariérní stránky firem',
    type: 'ashby',
    enabled: true,
    maxPages: 1,
    urls: [
      'https://jobs.ashbyhq.com/apify',
      'https://jobs.ashbyhq.com/rohlik',
      'https://jobs.ashbyhq.com/posthog',
      'https://jobs.ashbyhq.com/supabase',
      'https://jobs.ashbyhq.com/linear',
      'https://jobs.ashbyhq.com/n8n',
      'https://jobs.ashbyhq.com/sanity',
      'https://jobs.ashbyhq.com/lovable',
      'https://jobs.ashbyhq.com/elevenlabs',
      'https://jobs.ashbyhq.com/synthesia',
      'https://jobs.ashbyhq.com/pleo',
      'https://jobs.ashbyhq.com/livekit',
      'https://jobs.ashbyhq.com/docker',
      'https://jobs.ashbyhq.com/replit',
      'https://jobs.ashbyhq.com/resend',
      'https://jobs.ashbyhq.com/vanta',
      'https://jobs.ashbyhq.com/notion',
    ],
  },
  {
    id: 'lever',
    name: 'Lever – kariérní stránky firem',
    type: 'lever',
    enabled: true,
    maxPages: 1,
    urls: [
      'https://jobs.lever.co/spotify',
      'https://jobs.lever.co/toptal',
    ],
  },
  {
    id: 'smartrecruiters',
    name: 'SmartRecruiters – kariérní stránky firem',
    type: 'smartrecruiters',
    enabled: true,
    maxPages: 2,
    urls: [
      'https://jobs.smartrecruiters.com/Sportradar',
      'https://jobs.smartrecruiters.com/HomeCredit',
      'https://jobs.smartrecruiters.com/Ubisoft2',
    ],
  },
  {
    id: 'recruitee',
    name: 'Recruitee – kariérní stránky firem',
    type: 'recruitee',
    enabled: true,
    maxPages: 1,
    urls: [
      'https://livesport.recruitee.com/',
      'https://strv.recruitee.com/',
      'https://twisto.recruitee.com/',
    ],
  },
  {
    id: 'djinni',
    name: 'Djinni',
    type: 'jsonld',
    enabled: true,
    maxPages: 2,
    urls: ['https://djinni.co/jobs/?primary_keyword=React+Native', 'https://djinni.co/jobs/?primary_keyword=JavaScript&keywords=react'],
  },
  {
    id: 'remoterocketship',
    name: 'Remote Rocketship',
    type: 'remoterocketship',
    enabled: true,
    maxPages: 1,
    urls: ['https://www.remoterocketship.com/?jobTitle=react%20native', 'https://www.remoterocketship.com/?jobTitle=react'],
  },
  {
    id: 'remotecom',
    name: 'Remote.com',
    type: 'remotecom',
    enabled: true,
    maxPages: 1,
    urls: ['https://remote.com/jobs/all?query=react', 'https://remote.com/jobs/all?query=react%20native'],
  },
  {
    id: 'arc',
    name: 'Arc.dev',
    type: 'arc',
    enabled: true,
    maxPages: 1,
    urls: ['https://arc.dev/remote-jobs/react', 'https://arc.dev/remote-jobs/react-native'],
  },
  {
    id: 'bulldog',
    name: 'Bulldogjob.pl',
    type: 'bulldog',
    enabled: true,
    maxPages: 1,
    urls: ['https://bulldogjob.pl/companies/jobs/s/skills,React', 'https://bulldogjob.pl/companies/jobs/s/skills,React%20Native'],
  },
  {
    id: 'eurotechjobs',
    name: 'EuroTechJobs',
    type: 'eurotechjobs',
    enabled: true,
    maxPages: 1,
    urls: ['https://www.eurotechjobs.com/job_search/keyword/react'],
  },
  {
    id: 'landingjobs',
    name: 'Landing.jobs',
    type: 'landingjobs',
    enabled: true,
    maxPages: 3,
    urls: ['https://landing.jobs/api/v1/jobs?limit=50'],
  },
  {
    id: 'workingnomads',
    name: 'Working Nomads',
    type: 'workingnomads',
    enabled: true,
    maxPages: 1,
    urls: ['https://www.workingnomads.com/api/exposed_jobs/'],
  },
  {
    id: 'profesiask',
    name: 'Profesia.sk',
    type: 'profesia',
    enabled: true,
    maxPages: 1,
    urls: ['https://www.profesia.sk/praca/?search_anywhere=react'],
  },
  {
    id: 'weworkremotely-fullstack',
    name: 'We Work Remotely – Full-stack',
    type: 'rss',
    enabled: true,
    maxPages: 1,
    urls: ['https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss'],
  },
  {
    id: 'jooble',
    name: 'Jooble (API klíč)',
    type: 'jooble',
    // needs JOOBLE_API_KEY – enabled automatically when the variable is set
    enabled: !!process.env.JOOBLE_API_KEY,
    maxPages: 1,
    urls: ['https://jooble.org/api/?keywords=react&location=Brno', 'https://jooble.org/api/?keywords=react%20native&location=Czech%20Republic'],
  },
  {
    id: 'frontendengineers',
    name: 'FrontendEngineers.com',
    type: 'frontendengineers',
    enabled: true,
    maxPages: 1,
    urls: [
      'https://www.frontendengineers.com/remote-react-jobs',
      'https://www.frontendengineers.com/remote-frontend-jobs-europe',
      'https://www.frontendengineers.com/remote-frontend-jobs-worldwide',
      'https://www.frontendengineers.com/remote-senior-frontend-jobs',
    ],
  },
  {
    id: 'arbeitnow',
    name: 'Arbeitnow',
    type: 'arbeitnow',
    enabled: true,
    maxPages: 3,
    urls: ['https://www.arbeitnow.com/api/job-board-api'],
  },
];

// ------------------------------------------------------------------ example presets
// The default profile, title rules and search URLs come from one preset. Pick it with DEFAULT_PRESET;
// everything stays editable in the dashboard afterwards (and is saved to data/config.json).
type Preset = {
  profile: AppConfig['profile'];
  titleInclude: string[];
  titleGeneric: string[];
  titleGenericHints: string[];
  titleExclude: string[];
  /** per source id: replace URLs and/or enabled flag of BASE_SOURCES */
  sources: Record<string, Partial<Pick<SourceConfig, 'urls' | 'enabled'>>>;
};

export const PRESETS = {
  'react-native': {
    // senior React / React Native / TypeScript developer
    profile: {
      core: ['React Native', 'React', 'TypeScript', 'Expo', 'JavaScript'],
      strong: [
        'Redux',
        'Zustand',
        'GraphQL',
        'REST',
        'Node.js',
        'Firebase',
        'CI/CD',
        'App Store / Google Play',
        'OTA updates',
        'Git',
        'Mobile',
        'Frontend',
        'Architecture',
        'Code review',
      ],
      familiar: ['AWS', 'Vue', 'PHP', 'WordPress', 'HTML', 'CSS', 'Jest', 'Next.js', 'Fullstack', 'Fintech'],
      avoid: ['Angular', 'Java', 'C#', '.NET', 'Flutter'],
    },
    titleInclude: [
      'react',
      'front-?end',
      'front end',
      '\\bmobil', // not "automobilový"
      'mobile',
      'javascript',
      'typescript',
      'web developer',
      'web dev',
      'webov',
      'full-?stack',
      'full stack',
      'tech(nical)? lead',
      'team lead',
      'team leader',
      'vedoucí týmu',
      'technický vedoucí',
      'engineering manager',
      'head of (frontend|mobile|engineering)',
      'lead (developer|engineer)',
      'expo',
    ],
    titleGeneric: ['developer', 'engineer', 'vývojář', 'vývojářka', 'programátor', 'programmer', 'software'],
    titleGenericHints: ['frontend', 'front-end', 'mobile'],
    titleExclude: [
      'junior',
      'intern',
      'internship',
      'stáž',
      'trainee',
      'absolvent',
      '\\bqa\\b',
      'tester',
      'test automation',
      '^(?!.*react).*android',
      '^(?!.*react).*\\bios\\b',
      '^(?!.*react).*swift',
      '^(?!.*react).*kotlin',
      'flutter',
      '\\bjava\\b(?!script)',
      '\\.net',
      'c#',
      'python',
      'golang',
      'devops',
      'data (engineer|scientist|analyst)',
      '\\bsap\\b',
      'salesforce',
      'embedded',
      'designer',
      '^(?!.*(front|full|react|mobile)).*\\bback[- ]?end\\b', // backend-only
      '\\b(ml|machine learning|data|ai|llm)\\s+(engineer|scientist|researcher)',
      '^(?!.*(front|mobile|react|web|ui\\b)).*\\b(sre|site reliability|devsecops|security|infrastructure|platform|cloud|network|firmware|hardware)\\s+(engineer|developer|lead)',
      'solutions? (engineer|architect|consultant)',
      'support engineer',
      'grafik',
      'obchodník',
      'bankéř',
      'prodej',
      'účetní',
      'marketing',
      'sales',
      'customer',
      'support',
    ],
    sources: {}, // BASE_SOURCES already carry this preset's URLs
  },
  'java-fullstack': {
    // senior fullstack Java developer (Java / Spring backend, some Angular / TypeScript)
    profile: {
      core: ['Java', 'Spring Boot', 'SQL'],
      strong: ['Kotlin', 'Hibernate', 'REST', 'Microservices', 'Docker', 'Kubernetes', 'Kafka', 'AWS', 'CI/CD', 'Maven / Gradle', 'Git', 'Backend', 'Fullstack', 'Architecture', 'Code review'],
      familiar: ['TypeScript', 'Angular', 'JavaScript', 'Vue', 'GraphQL', 'MongoDB', 'Azure', 'GCP', 'Python'],
      avoid: ['PHP', 'WordPress', 'C#', '.NET'],
    },
    titleInclude: [
      '\\bjava\\b(?!script)',
      'kotlin',
      '\\bspring\\b',
      'full-?stack',
      'full stack',
      'back-?end',
      'back end',
      'tech(nical)? lead',
      'team lead',
      'team leader',
      'vedoucí týmu',
      'technický vedoucí',
      'engineering manager',
      'head of (backend|engineering)',
      'lead (developer|engineer)',
      '(software|solution|system) architect',
      'architekt',
    ],
    titleGeneric: ['developer', 'engineer', 'vývojář', 'vývojářka', 'programátor', 'programmer', 'software'],
    titleGenericHints: ['backend', 'back-end', 'fullstack', 'full-stack', 'microservices'],
    titleExclude: [
      'junior',
      'intern',
      'internship',
      'stáž',
      'trainee',
      'absolvent',
      '\\bqa\\b',
      'tester',
      'test automation',
      'android',
      '\\bios\\b',
      'swift',
      'flutter',
      'react native',
      '^(?!.*(full|java|back|kotlin)).*front-?end', // frontend-only
      '^(?!.*(full|java|back|kotlin)).*\\breact\\b', // React-only
      '\\.net',
      'c#',
      '\\bphp\\b',
      'golang',
      '^(?!.*java).*python',
      '\\bsap\\b',
      'salesforce',
      'embedded',
      'designer',
      '^(?!.*(java|kotlin|spring|scala)).*\\b(ml|machine learning|data|ai|llm)\\s+(engineer|scientist|researcher)',
      '^(?!.*(java|kotlin|spring|back|full)).*\\b(sre|site reliability|devsecops|security|infrastructure|platform|cloud|network|firmware|hardware)\\s+(engineer|developer|lead)',
      'solutions? (engineer|consultant)',
      '^(?!.*(java|kotlin|spring)).*support engineer',
      'grafik',
      'obchodník',
      'bankéř',
      'prodej',
      'účetní',
      'marketing',
      'sales',
      '^(?!.*(java|kotlin|spring|backend|fullstack)).*customer',
      '^(?!.*(java|kotlin|spring|backend|fullstack)).*support',
    ],
    sources: {
      jobscz: { urls: ['https://www.jobs.cz/prace/brno/?q%5B%5D=java', 'https://www.jobs.cz/prace/brno/?q%5B%5D=fullstack', 'https://www.jobs.cz/prace/?q%5B%5D=spring%20boot', 'https://www.jobs.cz/prace/?q%5B%5D=java&q%5B%5D=remote'] },
      pracecz: { urls: ['https://www.prace.cz/nabidky/brno/?q=java', 'https://www.prace.cz/nabidky/brno/?q=fullstack', 'https://www.prace.cz/nabidky/?q=spring%20boot'] },
      profesia: { urls: ['https://www.profesia.cz/prace/?search_anywhere=java', 'https://www.profesia.cz/prace/?search_anywhere=spring%20boot'] },
      linkedin: {
        urls: [
          li('Java', 'Brno, South Moravia, Czechia'),
          li('Fullstack Java', 'Brno, South Moravia, Czechia'),
          li('Java', 'Czechia', true),
          li('Java Spring', 'European Union', true),
          li('Kotlin', 'European Union', true),
          li('Tech Lead Java', 'Czechia'),
        ],
      },
      nofluffjobs: { urls: ['https://nofluffjobs.com/cz/Java?criteria=city%3Dbrno,remote', 'https://nofluffjobs.com/cz/fullstack?criteria=city%3Dbrno,remote', 'https://nofluffjobs.com/cz/backend?criteria=city%3Dbrno,remote'] },
      remoteok: { urls: ['https://remoteok.com/api?tag=java', 'https://remoteok.com/api?tag=kotlin'] },
      remotive: { urls: ['https://remotive.com/api/remote-jobs?category=software-dev&search=java', 'https://remotive.com/api/remote-jobs?category=software-dev&search=spring'] },
      weworkremotely: { urls: ['https://weworkremotely.com/categories/remote-back-end-programming-jobs.rss'] },
      himalayas: { urls: ['https://himalayas.app/jobs/api/search?q=java', 'https://himalayas.app/jobs/api/search?q=spring%20boot'] },
      jobicy: { urls: ['https://jobicy.com/api/v2/remote-jobs?count=50&tag=java'] },
      jobstack: { urls: ['https://www.jobstack.it/it-jobs/java-developer', 'https://www.jobstack.it/it-jobs/full-stack-developer'] },
      easyprace: { urls: ['https://www.easy-prace.cz/java-vyvojar', 'https://www.easy-prace.cz/brno/java-vyvojar'] },
      jobscontact: { urls: ['https://www.jobscontact.cz/prace?jobFilterFulltext%5B0%5D=java'] },
      reactjobs: { enabled: false }, // React-only board
      jsguru: { enabled: false }, // JavaScript-only board
      frontendengineers: { enabled: false }, // frontend-only board
      djinni: { urls: ['https://djinni.co/jobs/?primary_keyword=Java', 'https://djinni.co/jobs/?primary_keyword=Kotlin'] },
      remoterocketship: { urls: ['https://www.remoterocketship.com/?jobTitle=java', 'https://www.remoterocketship.com/?jobTitle=spring'] },
      remotecom: { urls: ['https://remote.com/jobs/all?query=java', 'https://remote.com/jobs/all?query=spring%20boot'] },
      arc: { urls: ['https://arc.dev/remote-jobs/java', 'https://arc.dev/remote-jobs/spring-boot'] },
      bulldog: { urls: ['https://bulldogjob.pl/companies/jobs/s/skills,Java', 'https://bulldogjob.pl/companies/jobs/s/skills,Spring'] },
      eurotechjobs: { urls: ['https://www.eurotechjobs.com/job_search/keyword/java'] },
      profesiask: { urls: ['https://www.profesia.sk/praca/?search_anywhere=java'] },
      jooble: { urls: ['https://jooble.org/api/?keywords=java&location=Brno', 'https://jooble.org/api/?keywords=java&location=Czech%20Republic'] },
    },
  },
} satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

/** Preset used for new installs and the "Defaults" button in the filters. */
export const DEFAULT_PRESET: PresetName = 'java-fullstack';

export function sourcesFor(name: PresetName): SourceConfig[] {
  const overrides: Preset['sources'] = PRESETS[name].sources;
  return BASE_SOURCES.map((s) => ({ ...s, ...overrides[s.id] }));
}

export const DEFAULT_SOURCES = sourcesFor(DEFAULT_PRESET);

/** Default source ids of the first release – configs created then have no seenDefaultSources. */
const ORIGINAL_DEFAULT_IDS = [
  'jobscz', 'pracecz', 'profesia', 'linkedin', 'nofluffjobs', 'remoteok',
  'remotive', 'weworkremotely', 'himalayas', 'jobicy', 'arbeitnow',
];

export function defaultConfig(name: PresetName = DEFAULT_PRESET): AppConfig {
  const preset: Preset = PRESETS[name];
  return {
    version: CONFIG_VERSION,
    preset: name,
    // Example profile – edit it in the dashboard (Profile & filters). See PRESETS / DEFAULT_PRESET.
    profile: preset.profile,
    filters: {
      minSalaryCzkMonth: 100_000,
      hideUnknownSalary: false,
      titleInclude: preset.titleInclude,
      titleGeneric: preset.titleGeneric,
      titleGenericHints: preset.titleGenericHints,
      titleExclude: preset.titleExclude,
      onsiteCities: ['Brno'],
      remoteAllowed: [
        'worldwide',
        'anywhere',
        'global',
        'europe',
        'european',
        '\\beu\\b',
        'emea',
        '\\bcet\\b',
        '\\bcest\\b',
        'czech',
        'czechia',
        'česk',
        'cesk',
        'brno',
        'praha',
        'prague',
        '\\bkraj\\b',
      ],
      remoteBlocked: [
        'us only',
        'usa only',
        'united states',
        '\\busa?\\b',
        'north america',
        'americas',
        'latam',
        'latin america',
        'canada',
        'india',
        'philippines',
        'brazil',
        'mexico',
        'apac',
        'australia',
        'uk only',
        'israel',
        'argentin',
        'colombia',
        'kolumbie',
        'chile',
        'peru',
        'ecuador',
        'panama',
        'costa rica',
        'uruguay',
        'belize',
        'nicaragua',
        'suriname',
        'guatemala',
        'honduras',
        'south africa',
        'nigeria',
        'kenya',
        'egypt',
        'pakistan',
        'bangladesh',
        'sri lanka',
        'vietnam',
        'indonesia',
        'malaysia',
        'singapore',
        'japan',
        'china',
        'new zealand',
        'united arab emirates',
        '\\buae\\b',
        'saudi',
        'spojené státy',
        'kanada',
        'indie',
        'brazílie',
        'mexiko',
        'filipíny',
      ],
    },
    settings: {
      scanIntervalMinutes: 60,
      port: 4321,
      openBrowser: true,
      notifications: true,
      maxDetailFetchesPerScan: 150,
      goneAfterHours: 72,
      // Off by default: the lookup stores contacts (personal data) – opt in via Nastavení, or use the per-job button.
      maxEnrichPerScan: 0,
      language: defaultLang(),
    },
    sources: sourcesFor(name),
    seenDefaultSources: BASE_SOURCES.map((s) => s.id),
  };
}

let current: AppConfig | null = null;

export function loadConfig(): AppConfig {
  const defaults = defaultConfig();
  const stored = readJson<Partial<AppConfig> | null>(CONFIG_FILE, null);
  if (!stored) {
    current = defaults;
    saveConfig(current);
    return current;
  }
  setServerLang(stored.settings?.language ?? defaults.settings.language);
  // Shallow-merge each section so new settings added in later versions get their defaults.
  current = {
    ...defaults,
    ...stored,
    profile: { ...defaults.profile, ...stored.profile },
    filters: { ...defaults.filters, ...stored.filters },
    settings: { ...defaults.settings, ...stored.settings },
    sources: stored.sources ?? defaults.sources,
    version: CONFIG_VERSION,
  };
  // Offer default sources added in newer versions – but only once, so a deleted default stays deleted.
  const seen = new Set(stored.seenDefaultSources ?? ORIGINAL_DEFAULT_IDS);
  const added = DEFAULT_SOURCES.filter((s) => !seen.has(s.id) && !current!.sources.some((x) => x.id === s.id));
  if (added.length || !stored.seenDefaultSources) {
    current.sources = [...current.sources, ...added];
    current.seenDefaultSources = [...new Set([...seen, ...DEFAULT_SOURCES.map((s) => s.id)])];
    saveConfig(current);
    if (added.length) console.log(msg('newSources', added.map((s) => s.name).join(', ')));
  }
  return current;
}

export function getConfig(): AppConfig {
  return current ?? loadConfig();
}

export function saveConfig(cfg: AppConfig): void {
  current = cfg;
  setServerLang(cfg.settings.language);
  writeJsonAtomic(CONFIG_FILE, cfg);
}
