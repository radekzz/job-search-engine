// Shared domain types. Kept free of runtime code so Node's type stripping handles it.

export type WorkMode = 'remote' | 'hybrid' | 'onsite' | 'unknown';
export type JobStatus = 'new' | 'watch' | 'applied' | 'rejected';
export type SalaryPeriod = 'hour' | 'day' | 'month' | 'year';
/** ok = passes, unclear = can't tell (shown with a warning), fail = filtered out */
export type Verdict = 'ok' | 'unclear' | 'fail';

export interface Salary {
  min?: number;
  max?: number;
  currency: string; // ISO code: CZK, EUR, USD, ...
  period: SalaryPeriod;
}

/** What an adapter returns for one listing. */
export interface RawJob {
  sourceJobId: string;
  url: string;
  title: string;
  company?: string;
  location?: string;
  workMode?: WorkMode;
  salaryText?: string;
  salary?: Salary;
  description?: string;
  tags?: string[];
  postedAt?: string;
  /** Direct "Apply" link to the employer / its ATS when the portal exposes it. */
  applyUrl?: string;
  /** Title/company/location are placeholders (e.g. from a URL slug) until the detail is fetched. */
  provisional?: boolean;
}

export interface Evaluation {
  verdict: Verdict;
  reasons: string[];
  workMode: WorkMode;
  location: Verdict;
  salary: Verdict | 'unknown';
  salaryCzkMonth?: { min?: number; max?: number };
}

export interface StackMatch {
  /** 0–100, null when no technology could be detected in the listing */
  score: number | null;
  matched: string[];
  missing: string[];
  avoided: string[];
}

export interface Contact {
  type: 'email' | 'phone';
  value: string;
  /** where it was published (URL or "popis nabídky") */
  source: string;
  /** always starts with "nutno ověřit" */
  note: string;
}

export interface Enrichment {
  at: string;
  status: 'found-original' | 'careers-only' | 'not-found' | 'agency' | 'error';
  originalUrl?: string;
  careersUrl?: string;
  companySite?: string;
  /** a non-portal link (e.g. apply link) that couldn't be tied to the employer's domain */
  externalUrl?: string;
  /** posted by a recruitment agency – agency contacts are dropped */
  agency: boolean;
  method: string[];
  contacts: Contact[];
  error?: string;
}

export interface JobChange {
  at: string;
  field: string;
  from?: string;
  to?: string;
}

export interface JobLink {
  sourceId: string;
  sourceName: string;
  url: string;
}

export interface Job extends RawJob {
  id: string; // `${sourceId}:${sourceJobId}`
  sourceId: string;
  sourceName: string;
  dupKey: string;
  links: JobLink[]; // the same offer found on other portals
  firstSeenAt: string;
  lastSeenAt: string;
  gone: boolean; // not seen in recent successful scans of its source
  status: JobStatus;
  statusChangedAt?: string;
  note?: string;
  detailFetched?: boolean;
  detailAttempts?: number;
  /**
   * Tombstone kept so the listing isn't re-created every scan:
   * merged = duplicate of `mergedInto`, irrelevant = real title (after detail) failed the role filter.
   */
  hidden?: 'merged' | 'irrelevant';
  /** employer's original posting / careers page + published contacts (heuristic → "nutno ověřit") */
  enrichment?: Enrichment;
  mergedInto?: string;
  evaluation: Evaluation;
  match: StackMatch;
  changes: JobChange[];
}

export type AdapterType =
  | 'jobscz'
  | 'pracecz'
  | 'profesia'
  | 'linkedin'
  | 'nofluffjobs'
  | 'remoteok'
  | 'remotive'
  | 'himalayas'
  | 'jobicy'
  | 'arbeitnow'
  | 'startupjobs'
  | 'jobstack'
  | 'easyprace'
  | 'jobscontact'
  | 'reactjobs'
  | 'jsguru'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'recruitee'
  | 'jsonld'
  | 'remoterocketship'
  | 'remotecom'
  | 'arc'
  | 'bulldog'
  | 'eurotechjobs'
  | 'landingjobs'
  | 'workingnomads'
  | 'jooble'
  | 'frontendengineers'
  | 'rss'
  | 'html';

export interface HtmlSelectors {
  item: string;
  title: string;
  link?: string; // defaults to first <a> in item
  company?: string;
  location?: string;
  salary?: string;
}

export interface SourceConfig {
  id: string;
  name: string;
  type: AdapterType;
  enabled: boolean;
  /** Search/listing URLs – copy them from the portal with filters applied. */
  urls: string[];
  maxPages: number;
  /** Only for type=html */
  selectors?: HtmlSelectors;
}

export interface Profile {
  core: string[];
  strong: string[];
  familiar: string[];
  avoid: string[];
}

export interface Filters {
  minSalaryCzkMonth: number;
  hideUnknownSalary: boolean;
  /** Title must match one of these (case-insensitive substrings / regex sources). */
  titleInclude: string[];
  /** Generic titles (developer, engineer...) only pass when the text mentions a core skill. */
  titleGeneric: string[];
  titleExclude: string[];
  /** Cities where onsite/hybrid is fine. */
  onsiteCities: string[];
  /** Region tokens that make a remote job OK when working from CZ. */
  remoteAllowed: string[];
  /** Region tokens that make a remote job fail. */
  remoteBlocked: string[];
}

export interface Settings {
  scanIntervalMinutes: number;
  port: number;
  openBrowser: boolean;
  notifications: boolean;
  maxDetailFetchesPerScan: number;
  /** After this many hours without being seen, a job is marked as gone. */
  goneAfterHours: number;
  /** How many jobs per scan get the original-posting / contacts lookup. */
  maxEnrichPerScan: number;
  /** Dashboard / notification language */
  language: 'cs' | 'en';
}

export interface AppConfig {
  version: number;
  profile: Profile;
  filters: Filters;
  settings: Settings;
  sources: SourceConfig[];
  /** Default source ids already offered to this install (so deleted defaults stay deleted). */
  seenDefaultSources?: string[];
  lastAcknowledgedAt?: string;
}

export interface SourceRunStatus {
  sourceId: string;
  startedAt: string;
  finishedAt?: string;
  ok: boolean;
  fetched: number;
  relevant: number;
  newJobs: number;
  errors: string[];
}

export interface ScanState {
  running: boolean;
  lastScanStartedAt?: string;
  lastScanFinishedAt?: string;
  nextScanAt?: string;
  sources: Record<string, SourceRunStatus>;
}
