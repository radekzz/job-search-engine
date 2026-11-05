import { dataPath, readJson, writeJsonAtomic } from './fsutil.ts';
import { msg } from './i18n.ts';
import type { Salary, SalaryPeriod } from './types.ts';

// --- Exchange rates (CZK per 1 unit), refreshed daily from ČNB -------------------------

const RATES_FILE = dataPath('rates.json');
const FALLBACK_RATES: Record<string, number> = { CZK: 1, EUR: 24.3, USD: 21, GBP: 28.5, PLN: 5.7, CHF: 26, SEK: 2.2 };
let rates: { fetchedAt: string; rates: Record<string, number> } = readJson(RATES_FILE, {
  fetchedAt: '1970-01-01T00:00:00Z',
  rates: FALLBACK_RATES,
});

export async function refreshRates(): Promise<void> {
  if (Date.now() - Date.parse(rates.fetchedAt) < 12 * 3600_000) return;
  try {
    const res = await fetch(
      'https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt',
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Format: "země|měna|množství|kód|kurz", decimal comma.
    const parsed: Record<string, number> = { CZK: 1 };
    for (const line of (await res.text()).split('\n').slice(2)) {
      const [, , amount, code, rate] = line.trim().split('|');
      if (!code || !rate) continue;
      parsed[code] = Number(rate.replace(',', '.')) / Number(amount);
    }
    if (parsed.EUR) {
      rates = { fetchedAt: new Date().toISOString(), rates: { ...FALLBACK_RATES, ...parsed } };
      writeJsonAtomic(RATES_FILE, rates);
    }
  } catch (err) {
    console.warn(msg('ratesDown', (err as Error).message));
  }
}

// --- Parsing --------------------------------------------------------------------------

const CURRENCY_PATTERNS: [RegExp, string][] = [
  [/kč|czk|,-/i, 'CZK'],
  [/€|eur/i, 'EUR'],
  [/£|gbp/i, 'GBP'],
  [/pln|zł/i, 'PLN'],
  [/chf/i, 'CHF'],
  [/\$|usd/i, 'USD'],
];

// Word-bounded (unicode-aware) so "hodnocení" ≠ hour and "4-day week" ≠ day.
// Month/year are checked first – they win when a text mentions several.
const W = (src: string) => new RegExp(`(?<!\\p{L})(?:${src})(?!\\p{L})`, 'iu');
const PERIOD_PATTERNS: [RegExp, SalaryPeriod][] = [
  [W('měs\\S*|mes\\.|month\\S*|mo|mies\\S*'), 'month'],
  [W('rok|roč\\S*|year\\S*|annual\\S*|yr|p\\.a\\.|pa'), 'year'],
  [W('hod|hod\\.|hodin\\S*|hour\\S*|hr|h'), 'hour'],
  [W('md|man-?day|daily|den|day'), 'day'],
];
// "day"/"den"/"h" alone are too ambiguous unless written as a rate ("/den", "per day", "za den", "/h")
const AMBIGUOUS = /^(?:den|day|h)$/i;

/** "55 000 – 70 000 Kč/měsíc", "Od 25 EUR/hod.", "$3.5k–$5k/month", "€60,000 - €80,000 a year" */
export function parseSalary(text: string | undefined, defaultCurrency?: string): Salary | undefined {
  if (!text) return undefined;
  const t = text.replace(/[​-‍  ]/g, ' ');
  const nums: number[] = [];
  // number with optional thousand separators (space, comma, dot) and optional k/m suffix
  // suffix must not be followed by a letter – otherwise "140 000 Kč" would read as 140 000 k
  const re = /(\d{1,3}(?:[ ,.'](?=\d{3}(?!\d))\d{3})+|\d+(?:[.,]\d+)?)\s*(k|m|tis\.?|tisíc)?(?!\p{L})/giu;
  const mults: number[] = [];
  for (const m of t.matchAll(re)) {
    let raw = m[1];
    const suffix = m[2]?.toLowerCase();
    if (/[ ']/.test(raw) || /[.,]\d{3}$/.test(raw)) raw = raw.replace(/[ ,.']/g, '');
    else raw = raw.replace(',', '.');
    let n = Number(raw);
    if (!Number.isFinite(n)) continue;
    const mult = suffix === 'm' ? 1_000_000 : suffix ? 1000 : 1; // k / tis. / tisíc
    nums.push(n * mult);
    mults.push(mult);
  }
  // "50–70k" / "60 - 80 tis. Kč": suffix written only after the upper bound
  if (nums.length >= 2 && mults[0] === 1 && mults[1] > 1 && nums[0] * mults[1] <= nums[1] * 2 && nums[0] < nums[1] / 100) {
    nums[0] *= mults[1];
  }
  // ignore stray digits (e.g. "B2B 2 roky") – after suffix propagation so "2 - 3 tis." stays 2000–3000
  for (let i = nums.length - 1; i >= 0; i--) if (nums[i] < 5) nums.splice(i, 1);
  if (!nums.length) return undefined;
  const currency = CURRENCY_PATTERNS.find(([r]) => r.test(t))?.[1] ?? defaultCurrency;
  if (!currency) return undefined;
  const min = Math.min(...nums.slice(0, 2));
  const max = Math.max(...nums.slice(0, 2));
  const onlyUpper = /^\s*(do|up to|až)(?=\s|\d)/i.test(t);
  const onlyLower = /^\s*(od|from|min\.?)(?=\s|\d)/i.test(t);
  const period = detectPeriod(t) ?? guessPeriod(max, currency);
  return {
    min: onlyUpper && nums.length === 1 ? undefined : min,
    max: onlyLower && nums.length === 1 ? undefined : max,
    currency,
    period,
  };
}

function detectPeriod(t: string): SalaryPeriod | undefined {
  for (const [r, p] of PERIOD_PATTERNS) {
    const m = t.match(r);
    if (!m) continue;
    if (AMBIGUOUS.test(m[0])) {
      // accept only in rate form: "/den", "/h", "per day", "za den"
      const i = m.index ?? 0;
      if (!/(?:\/\s*|per |za |a )$/i.test(t.slice(Math.max(0, i - 4), i))) continue;
    }
    return p;
  }
  return undefined;
}

function guessPeriod(value: number, currency: string): SalaryPeriod {
  const czk = value * (rates.rates[currency] ?? 1);
  if (czk < 3_000) return 'hour';
  if (czk < 20_000) return 'day';
  if (czk < 600_000) return 'month';
  return 'year';
}

const TO_MONTH: Record<SalaryPeriod, number> = { hour: 160, day: 20, month: 1, year: 1 / 12 };

export function toCzkMonth(s: Salary): { min?: number; max?: number } | undefined {
  const rate = rates.rates[s.currency];
  if (!rate) return undefined;
  const conv = (v?: number) => (v == null ? undefined : Math.round(v * rate * TO_MONTH[s.period]));
  return { min: conv(s.min), max: conv(s.max) };
}

export function formatSalary(s: Salary): string {
  const f = (v?: number) => (v == null ? '?' : v.toLocaleString('cs-CZ'));
  const range =
    s.min != null && s.max != null
      ? s.min === s.max
        ? f(s.min)
        : `${f(s.min)}–${f(s.max)}`
      : s.min != null
        ? `od ${f(s.min)}`
        : `do ${f(s.max)}`;
  const per = { hour: '/hod', day: '/MD', month: '/měs', year: '/rok' }[s.period];
  return `${range} ${s.currency}${per}`;
}
