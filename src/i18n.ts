// Server-side messages (terminal logs + desktop notifications) in the dashboard language.
// The dashboard translates everything else itself (public/i18n.js).

export type Lang = 'cs' | 'en';

let current: Lang = 'en';

/** Called by config.ts whenever the config is loaded or saved. */
export function setServerLang(lang: Lang | undefined): void {
  current = lang === 'cs' ? 'cs' : 'en';
}

export function defaultLang(): Lang {
  return /^cs/i.test(process.env.LANG ?? process.env.LC_ALL ?? '') ? 'cs' : 'en';
}

type Fn = (...a: any[]) => string;
const MESSAGES: Record<string, { cs: Fn; en: Fn }> = {
  scanAll: { cs: () => 'Spouštím sken všech zdrojů…', en: () => 'Scanning all sources…' },
  scanOne: { cs: (id) => `Sken zdroje ${id}…`, en: (id) => `Scanning source ${id}…` },
  sourceDone: {
    cs: (name, f, r, n, e) => `✓ ${name}: ${f} staženo, ${r} relevantních, ${n} nových${e ? `, ${e} chyb` : ''}`,
    en: (name, f, r, n, e) => `✓ ${name}: ${f} fetched, ${r} relevant, ${n} new${e ? `, ${e} errors` : ''}`,
  },
  scanDone: { cs: (n) => `Sken hotov: ${n} nových vyhovujících nabídek.`, en: (n) => `Scan finished: ${n} new matching offers.` },
  scanFailed: { cs: () => 'Sken selhal', en: () => 'Scan failed' },
  enrichStart: { cs: (n) => `Dohledávám originální nabídky a kontakty (${n})…`, en: (n) => `Looking up original postings and contacts (${n})…` },
  enrichDone: { cs: (n) => `Dohledávání hotovo: ${n} originálních nabídek nalezeno.`, en: (n) => `Lookup finished: ${n} original postings found.` },
  enrichFailed: { cs: () => 'Dohledávání selhalo', en: () => 'Lookup failed' },
  notify: {
    cs: (n, title, company) => `${n}× nová nabídka (na dashboardu nahoře se štítkem NOVÉ) – např. ${title} (${company})`,
    en: (n, title, company) => `${n} new offer${n > 1 ? 's' : ''} (on top of the dashboard, marked NEW) – e.g. ${title} (${company})`,
  },
  banner: {
    cs: (url, min) => `\n  Dashboard: ${url}\n  Sken každých ${min} min. Ukončení: Ctrl+C (stav se ukládá průběžně)\n`,
    en: (url, min) => `\n  Dashboard: ${url}\n  Scanning every ${min} min. Stop with Ctrl+C (state is saved continuously)\n`,
  },
  portBusy: {
    cs: (p) => `Port ${p} je obsazený – neběží už jiná instance? (případně PORT=4322 npm start)`,
    en: (p) => `Port ${p} is in use – is another instance running? (or try PORT=4322 npm start)`,
  },
  shutdown: { cs: () => '\nUkládám a končím…', en: () => '\nSaving and exiting…' },
  dedup: { cs: (n) => `[dedup] Sloučeno ${n} duplicitních nabídek`, en: (n) => `[dedup] Merged ${n} duplicate offers` },
  newSources: { cs: (list) => `[config] Přidány nové výchozí zdroje: ${list}`, en: (list) => `[config] Added new default sources: ${list}` },
  ratesDown: {
    cs: (e) => `[kurzy] ČNB nedostupná, používám uložené kurzy: ${e}`,
    en: (e) => `[rates] Czech National Bank unavailable, using cached rates: ${e}`,
  },
  corrupt: { cs: (f, b) => `[data] ${f} nešel načíst, záloha: ${b}`, en: (f, b) => `[data] ${f} could not be read, backup: ${b}` },
  cliDelegated: {
    cs: (url) => `Dashboard běží – sken spuštěn v něm, výsledky na ${url}`,
    en: (url) => `The dashboard is running – the scan was started there, see ${url}`,
  },
  cliDelegateFail: { cs: (e) => `Dashboard běží, ale sken nešel spustit: ${e}`, en: (e) => `The dashboard is running, but the scan could not start: ${e}` },
  cliSummary: {
    cs: (all, ok) => `\nCelkem uloženo ${all} nabídek, vyhovujících ${ok}.`,
    en: (all, ok) => `\nStored ${all} offers in total, ${ok} matching.`,
  },
};

export function msg(key: keyof typeof MESSAGES, ...args: unknown[]): string {
  return MESSAGES[key][current](...args);
}

export const timeLocale = () => (current === 'cs' ? 'cs-CZ' : 'en-GB');
