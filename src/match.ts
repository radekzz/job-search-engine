import type { Profile, RawJob, StackMatch } from './types.ts';

/**
 * Technology dictionary: canonical name -> regex (tested on lower-cased text).
 * Canonical names are what profiles use; unknown profile tags fall back to a literal match.
 */
const TECH: Record<string, RegExp> = {
  'React Native': /react[\s-]?native|\brn\b developer/,
  React: /\breact(?:\.?js)?\b(?![\s-]?native)/,
  TypeScript: /typescript|\bts\b(?!-)/,
  JavaScript: /javascript|\bjs\b|ecmascript|es6/,
  Expo: /\bexpo\b|\beas\b(?: build| update)?/,
  Redux: /\bredux\b|redux toolkit|\brtk\b/,
  Zustand: /zustand/,
  MobX: /\bmobx\b/,
  'React Query': /react[\s-]query|tanstack/,
  'Next.js': /next\.?js|\bnextjs\b/,
  Remix: /\bremix\b/,
  Vue: /\bvue(?:\.?js)?\b/,
  Nuxt: /\bnuxt/,
  Angular: /\bangular/,
  Svelte: /svelte/,
  'Node.js': /node\.?js|\bnode\b/,
  NestJS: /nest\.?js/,
  Express: /express\.?js/,
  GraphQL: /graphql|\bapollo\b/,
  REST: /\brest(?:ful)?\b(?: api)?/,
  Firebase: /firebase|firestore/,
  AWS: /\baws\b|amazon web services|lambda/,
  GCP: /\bgcp\b|google cloud/,
  Azure: /\bazure\b/,
  Docker: /docker/,
  Kubernetes: /kubernetes|\bk8s\b/,
  'CI/CD': /ci\/cd|\bci\b|github actions|gitlab ci|bitrise|circleci|fastlane/,
  'App Store / Google Play': /app store|google play|play store|testflight|app release|store release/,
  'OTA updates': /\bota\b|over[- ]the[- ]air|codepush|eas update/,
  Jest: /\bjest\b/,
  'Testing Library': /testing[- ]library/,
  Detox: /\bdetox\b/,
  Cypress: /cypress/,
  Playwright: /playwright/,
  Storybook: /storybook/,
  Tailwind: /tailwind/,
  CSS: /\bcss\b|scss|\bsass\b|styled[- ]components/,
  HTML: /\bhtml5?\b/,
  Webpack: /webpack|\bvite\b|esbuild|metro bundler/,
  Git: /\bgit\b|github|gitlab|bitbucket/,
  Monorepo: /monorepo|\bnx\b|turborepo|lerna/,
  PHP: /\bphp\b|laravel|symfony|nette/,
  WordPress: /wordpress/,
  Python: /\bpython\b|django|flask|fastapi/,
  Java: /\bjava\b(?!script)/,
  'Spring Boot': /spring[\s-]?boot|\bspring\b/,
  Hibernate: /hibernate|\bjpa\b/,
  Kafka: /kafka/,
  Microservices: /micro-?services?/,
  'Maven / Gradle': /\bmaven\b|gradle/,
  Kotlin: /kotlin/,
  Swift: /\bswift\b|swiftui/,
  'Objective-C': /objective-?c/,
  Flutter: /flutter|\bdart\b/,
  'C#': /c#|\.net\b|dotnet/,
  '.NET': /\.net\b|dotnet/,
  Go: /\bgolang\b|\bgo\b developer/,
  Rust: /\brust\b/,
  Ruby: /\bruby\b|rails/,
  SQL: /\bsql\b|postgres|mysql|mariadb/,
  MongoDB: /mongo/,
  Figma: /figma/,
  Sentry: /sentry/,
  'Mobile': /mobile|mobiln/,
  'Frontend': /front[- ]?end/,
  'Backend': /back[- ]?end/,
  'Fullstack': /full[- ]?stack/,
  'Architecture': /architect/,
  'Code review': /code review/,
  'Fintech': /fintech|banking|payments|crowdfunding/,
  Electron: /electron/,
  WebSockets: /websocket|socket\.io/,
  i18n: /\bi18n\b|localization|localisation/,
  Accessibility: /accessibility|\ba11y\b|wcag/,
};

/** Generic tags we detect but don't count into the score denominator (too vague). */
const NEUTRAL = new Set(['Git', 'REST', 'HTML', 'CSS', 'Mobile', 'Frontend', 'Backend', 'Fullstack', 'Architecture', 'Code review', 'Fintech']);

export const KNOWN_TECH = Object.keys(TECH);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Regex for a profile tag: the dictionary pattern for known tech (e.g. Java ≠ JavaScript), else a word-bounded literal. */
export function patternFor(tag: string): RegExp {
  const known = Object.keys(TECH).find((k) => k.toLowerCase() === tag.toLowerCase());
  if (known) return TECH[known];
  // Custom manual tag, e.g. "Reanimated" -> word-ish literal match
  return new RegExp(`(?:^|[^a-z0-9])${escapeRe(tag.toLowerCase())}(?:$|[^a-z0-9])`);
}

export function jobText(job: Pick<RawJob, 'title' | 'description' | 'tags'>): string {
  return [job.title, ...(job.tags ?? []), job.description ?? ''].join(' \n ').toLowerCase();
}

/** Detect which technologies (dictionary + custom profile tags) a listing mentions. */
export function detectTech(text: string, profile: Profile): string[] {
  const found = new Set<string>();
  for (const [name, re] of Object.entries(TECH)) if (re.test(text)) found.add(name);
  for (const tag of [...profile.core, ...profile.strong, ...profile.familiar, ...profile.avoid]) {
    const known = KNOWN_TECH.find((k) => k.toLowerCase() === tag.toLowerCase());
    if (!known && patternFor(tag).test(text)) found.add(tag);
  }
  // avoid double-flagging .NET + C#
  if (found.has('C#') && found.has('.NET')) found.delete('.NET');
  return [...found];
}

export function computeMatch(job: RawJob, profile: Profile): StackMatch {
  const norm = (s: string) => s.toLowerCase();
  const weight = new Map<string, number>();
  for (const t of profile.familiar) weight.set(norm(t), 1);
  for (const t of profile.strong) weight.set(norm(t), 2);
  for (const t of profile.core) weight.set(norm(t), 3);
  const avoid = new Set(profile.avoid.map(norm));

  const detected = detectTech(jobText(job), profile);
  const matched = detected.filter((t) => weight.has(norm(t)));
  const avoided = detected.filter((t) => avoid.has(norm(t)));
  const missing = detected.filter((t) => !weight.has(norm(t)) && !avoid.has(norm(t)) && !NEUTRAL.has(t));

  const counted = detected.filter((t) => !NEUTRAL.has(t));
  if (!counted.length) return { score: null, matched, missing, avoided };

  // Coverage of the job's stack, weighted by how well I know each piece.
  let sum = 0;
  for (const t of counted) sum += weight.get(norm(t)) ?? 0;
  let score = (sum / (3 * counted.length)) * 100;
  // Hitting a core skill is what matters most – give it a floor.
  const coreHits = counted.filter((t) => weight.get(norm(t)) === 3).length;
  if (coreHits) score = Math.max(score, 40 + coreHits * 12);
  score -= avoided.length * 15;
  return { score: Math.max(0, Math.min(100, Math.round(score))), matched, missing, avoided };
}

/** Extract tags from free text (CV / LinkedIn "Skills" paste) for profile import. */
export function extractTagsFromText(text: string): string[] {
  const lower = text.toLowerCase();
  return KNOWN_TECH.filter((k) => !NEUTRAL.has(k) && TECH[k].test(lower));
}
