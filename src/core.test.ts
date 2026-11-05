// Run: npm test   (node:test, no extra deps)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig } from './config.ts';
import { evaluate, isRelevant } from './filters.ts';
import { computeMatch } from './match.ts';
import { parseSalary } from './salary.ts';
import type { RawJob } from './types.ts';

const cfg = defaultConfig();
const job = (over: Partial<RawJob>): RawJob => ({ sourceJobId: '1', url: 'https://x', title: 'React Developer', ...over });

test('parseSalary: CZK ranges, "Kč" is not a k-suffix', () => {
  assert.deepEqual(parseSalary('100 000 – 140 000 Kč/měsíc'), { min: 100000, max: 140000, currency: 'CZK', period: 'month' });
  assert.deepEqual(parseSalary('75 000 ‍–‍ 100 000 Kč'), { min: 75000, max: 100000, currency: 'CZK', period: 'month' });
});

test('parseSalary: k suffix, periods, open ranges', () => {
  assert.deepEqual(parseSalary('$3.5k–$5k/month'), { min: 3500, max: 5000, currency: 'USD', period: 'month' });
  assert.equal(parseSalary('€60,000 - €80,000 a year')?.period, 'year');
  assert.equal(parseSalary('6 000 Kč/MD')?.period, 'day');
  assert.deepEqual(parseSalary('Od 25 EUR/hod.'), { min: 25, max: undefined, currency: 'EUR', period: 'hour' });
  assert.deepEqual(parseSalary('až 120 000 Kč'), { min: undefined, max: 120000, currency: 'CZK', period: 'month' });
  assert.equal(parseSalary('bez platu'), undefined);
});

test('isRelevant: role titles', () => {
  assert.ok(isRelevant(job({ title: 'Senior React Native Engineer' }), cfg));
  assert.ok(isRelevant(job({ title: 'Frontend Tech Lead' }), cfg));
  assert.ok(isRelevant(job({ title: 'React Native / iOS Developer' }), cfg));
  assert.ok(!isRelevant(job({ title: 'Junior React Developer' }), cfg));
  assert.ok(!isRelevant(job({ title: 'iOS Developer (Swift)' }), cfg));
  assert.ok(!isRelevant(job({ title: 'Java Developer' }), cfg));
  assert.ok(!isRelevant(job({ title: 'Automobilový obchodník Praha' }), cfg));
  assert.ok(isRelevant(job({ title: 'Vývojář mobilních aplikací' }), cfg));
  assert.ok(!isRelevant(job({ title: 'Backend Engineer - Subscriptions', description: 'Java, some React' }), cfg));
  assert.ok(!isRelevant(job({ title: 'Applied AI Engineer', description: 'Python, React dashboard' }), cfg));
  assert.ok(isRelevant(job({ title: 'Senior Full-stack Engineer (React / Node backend)' }), cfg));
  assert.ok(isRelevant(job({ title: 'Senior Platform Frontend Engineer' }), cfg));
  assert.ok(isRelevant(job({ title: 'Frontend Platform Engineer' }), cfg));
  assert.ok(isRelevant(job({ title: 'Mobile Platform Engineer (React Native)' }), cfg));
  assert.ok(!isRelevant(job({ title: 'Cloud Platform Engineer', description: 'Kubernetes, some React' }), cfg));
  // generic title needs a core skill in the text
  assert.ok(isRelevant(job({ title: 'Software Engineer', description: 'We use React and TypeScript' }), cfg));
  assert.ok(!isRelevant(job({ title: 'Software Engineer', description: 'Rust and C++' }), cfg));
});

test('evaluate: location rules', () => {
  assert.equal(evaluate(job({ location: 'Brno – Trnitá', workMode: 'onsite' }), cfg).verdict, 'ok');
  assert.equal(evaluate(job({ location: 'Praha', workMode: 'hybrid' }), cfg).verdict, 'fail');
  assert.equal(evaluate(job({ location: 'Praha', workMode: 'remote' }), cfg).verdict, 'ok');
  assert.equal(evaluate(job({ location: 'Worldwide', workMode: 'remote' }), cfg).verdict, 'ok');
  assert.equal(evaluate(job({ location: 'United States', workMode: 'remote' }), cfg).verdict, 'fail');
  assert.equal(evaluate(job({ title: 'React Dev - Latin America, Remote', location: 'Ecuador', workMode: 'remote' }), cfg).verdict, 'fail');
  assert.equal(evaluate(job({ location: 'Německo', workMode: 'remote' }), cfg).verdict, 'unclear');
  assert.equal(
    evaluate(job({ location: 'Německo', workMode: 'remote', description: 'You can work remotely from anywhere in Europe.' }), cfg).verdict,
    'ok',
  );
});

test('evaluate: salary threshold uses CZK/month equivalent', () => {
  const brno = { location: 'Brno', workMode: 'onsite' as const };
  assert.equal(evaluate(job({ ...brno, salary: parseSalary('60 000 – 80 000 Kč') }), cfg).salary, 'fail');
  assert.equal(evaluate(job({ ...brno, salary: parseSalary('90 000 – 130 000 Kč') }), cfg).salary, 'ok');
  assert.equal(evaluate(job({ ...brno, salary: parseSalary('900 Kč/hod') }), cfg).salary, 'ok'); // 900 × 160
  assert.equal(evaluate(job({ ...brno }), cfg).salary, 'unknown');
});

test('computeMatch: core stack scores high, avoided stack penalised', () => {
  const rn = computeMatch(job({ title: 'React Native Developer', description: 'TypeScript, Expo, Redux' }), cfg.profile);
  assert.ok((rn.score ?? 0) >= 90, `expected ≥90, got ${rn.score}`);
  const ng = computeMatch(job({ title: 'Frontend Developer', description: 'Angular, RxJS, Java backend' }), cfg.profile);
  assert.ok((ng.score ?? 100) < 30, `expected <30, got ${ng.score}`);
  assert.deepEqual(ng.avoided.sort(), ['Angular', 'Java']);
  assert.equal(computeMatch(job({ title: 'Developer', description: 'Great team' }), cfg.profile).score, null);
});

test('review regressions: "tis.", suffix on upper bound, word-bounded periods', () => {
  assert.deepEqual(parseSalary('60 - 80 tis. Kč'), { min: 60000, max: 80000, currency: 'CZK', period: 'month' });
  assert.deepEqual(parseSalary('80-100 tis. Kč měsíčně'), { min: 80000, max: 100000, currency: 'CZK', period: 'month' });
  assert.deepEqual(parseSalary('50–70k CZK'), { min: 50000, max: 70000, currency: 'CZK', period: 'month' });
  assert.equal(parseSalary('$120k/year, 4-day week')?.period, 'year');
  assert.equal(parseSalary('100 000 Kč/měsíc, hodnocení výkonu')?.period, 'month');
  assert.equal(parseSalary('500 EUR/den')?.period, 'day');
  assert.equal(parseSalary('60 €/h')?.period, 'hour');
});

test('review regressions: occasional home office is hybrid, not remote', () => {
  const prg = job({ location: 'Praha', description: 'Benefity: možnost občasné práce z domova, stravenky' });
  assert.equal(evaluate(prg, cfg).workMode, 'hybrid');
  assert.equal(evaluate(prg, cfg).verdict, 'fail');
  assert.equal(evaluate(job({ location: 'Praha', description: 'Možnost práce z domova.' }), cfg).workMode, 'hybrid');
  assert.equal(evaluate(job({ location: 'Praha', description: 'Práce převážně z domova.' }), cfg).workMode, 'remote');
});

test('provisional (StartupJobs slug) flow: merge into known offer, drop irrelevant, no re-creation', async () => {
  // upsert/applyDetail only mutate memory; nothing is flushed to data/ here
  const { upsert, applyDetail, visibleJobs } = await import('./store.ts');
  const tag = `t${Date.now()}`;
  const other = { id: `test-li-${tag}`, name: 'LinkedIn', type: 'linkedin' as const, enabled: true, urls: [], maxPages: 1 };
  const sj = { id: `test-sj-${tag}`, name: 'StartupJobs', type: 'startupjobs' as const, enabled: true, urls: [], maxPages: 1 };

  const known = upsert(job({ sourceJobId: 'a', title: `Senior React Native Developer ${tag}`, company: 'Acme', location: 'Brno' }), other, cfg).job;
  const prov = upsert(job({ sourceJobId: '1', title: `senior react native developer ${tag}`, provisional: true }), sj, cfg);
  assert.ok(prov.isNew);
  applyDetail(prov.job, { title: `Senior React Native Developer ${tag}`, company: 'Acme s.r.o.', location: 'Brno' }, cfg);
  assert.equal(prov.job.hidden, 'merged');
  assert.equal(known.links.at(-1)?.sourceId, sj.id);
  // next scan: the slug shows up again → resolves to the primary, nothing new
  const again = upsert(job({ sourceJobId: '1', title: `senior react native developer ${tag}`, provisional: true }), sj, cfg);
  assert.equal(again.isNew, false);
  assert.equal(again.job.id, known.id);

  const bad = upsert(job({ sourceJobId: '2', title: `grafik pro mobilni hry ${tag}`, provisional: true }), sj, cfg).job;
  applyDetail(bad, { title: `Grafik pro mobilní hry ${tag}`, company: 'Games' }, cfg);
  assert.equal(bad.hidden, 'irrelevant');
  assert.ok(!visibleJobs().some((j) => j.id === bad.id || j.id === prov.job.id));
});

test('"Global" means remote only as a location, not in the title', () => {
  assert.equal(evaluate(job({ title: 'Frontend Developer – Global Payments', location: 'Praha' }), cfg).workMode, 'onsite');
  assert.equal(evaluate(job({ title: 'Frontend Developer', location: 'Worldwide' }), cfg).workMode, 'remote');
});

test('dedup keys: same offer across portals, different companies never collide', async () => {
  const { dupKey, sameOffer } = await import('./store.ts');
  const same = (a: [string, string], b: [string, string]) => sameOffer(dupKey({ title: a[0], company: a[1] }), dupKey({ title: b[0], company: b[1] }));
  assert.ok(same(['(Senior) React Native Engineer (m/f/x) - Based in Germany', 'Cara Care GmbH'], ['Senior React Native Engineer', 'Cara Care']));
  assert.ok(same(['Sr. Frontend Developer – Remote', 'Rohlik Group'], ['Senior Frontend Developer (Prague, hybrid)', 'Rohlik']));
  assert.ok(same(['Vývojář/ka React (m/ž)', 'Jobs Contact Personal, s.r.o.'], ['Vývojář/ka React', 'JobsContact']));
  assert.ok(!same(['Frontend Developer', 'Česká spořitelna'], ['Frontend Developer', 'Česká pojišťovna']));
  assert.ok(!same(['React Developer', 'Komerční banka'], ['React Developer', 'Komerční pojišťovna']));
  assert.ok(!same(['Frontend Developer', 'Red Hat Czech'], ['Frontend Developer', 'Red Bull']));
  assert.ok(!same(['React Developer', 'ČEZ'], ['React Developer', 'ČEZ Distribuce']));
  assert.ok(!same(['React Developer', 'Jobs.cz'], ['React Developer', 'Jobs Contact Personal']));
  assert.ok(!same(['React Developer', 'Software AG'], ['React Developer', 'Software Inc'])); // empty company key
  assert.ok(!same(['Senior Software Engineer - Frontend - Consumer', 'Kraken'], ['Senior Software Engineer - React Native - Consumer', 'Kraken']));
});

test('enrichment: official URL detection and contact filtering', async () => {
  const { isOfficialUrl, classifyUrl, extractContacts } = await import('./enrich.ts');
  assert.ok(isOfficialUrl('https://jobs.ashbyhq.com/apify/123', 'Apify'));
  assert.ok(isOfficialUrl('https://uniqa.jobs.cz/detail-pozice?id=1', 'UNIQA'));
  assert.ok(isOfficialUrl('https://career.notino.cz/', 'Notino s.r.o.'));
  assert.ok(isOfficialUrl('https://stripe.com/jobs/listing/1', 'Stripe'));
  assert.ok(!isOfficialUrl('https://www.jobs.cz/rpd/1/', 'UNIQA'));
  assert.ok(!isOfficialUrl('https://firmy.jobs.cz/', 'UNIQA')); // portal's B2B section, not a microsite
  assert.ok(!isOfficialUrl('https://cz.linkedin.com/jobs/view/1', 'Notino'));
  assert.ok(!isOfficialUrl('https://bit.ly/abc', 'Notino'));
  assert.ok(!isOfficialUrl('https://www.dice.com/job-detail/1', 'Acme'));
  // unknown domain not carrying the company name → only "external", never "original"
  assert.equal(classifyUrl('https://some-random-site.com/job/1', 'Acme'), 'external');

  const text = 'Pište na kariera@firma-x.example nebo jan.novak@firma-x.example, tel. +420 000 111 222. Formulář: jmeno@domena.cz, +420123456789, noreply@firma-x.example, logo@2x.png';
  const c = extractContacts(text, 'popis nabídky', 'www.firma-x.example', false);
  assert.deepEqual(c.map((x) => x.value), ['kariera@firma-x.example', 'jan.novak@firma-x.example', '+420 000 111 222']);
  assert.ok(c.every((x) => x.note.startsWith('nutno ověřit')));
  assert.match(c[0].note, /náborová schránka · doména firmy/);
  // agency posting: only employer-domain e-mails survive, no phones
  const a = extractContacts('Kontakt: petra@agentura-y.example, +420 000 111 222, hr@firma-x.example', 'popis nabídky', 'firma-x.example', true);
  assert.deepEqual(a.map((x) => x.value), ['hr@firma-x.example']);
  // non-job page (homepage / general careers page): only mailboxes, no personal addresses or phones
  const strict = extractContacts('jan.novak@firma-x.example, info@firma-x.example, +420 000 111 222', 'https://firma-x.example/', 'firma-x.example', false, true);
  assert.deepEqual(strict.map((x) => x.value), ['info@firma-x.example']);
});

test('SSRF guard blocks local / private targets', async () => {
  const { fetchPage, BlockedUrlError } = await import('./http.ts');
  for (const u of ['http://localhost:4321/api/state', 'http://127.0.0.1/', 'http://192.168.1.1/', 'http://10.0.0.5/', 'http://[::1]/', 'http://169.254.169.254/', 'file:///etc/passwd', 'http://router/', 'http://0x7f000001/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:192.168.1.1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[fec0::1]/', 'http://[fd00::1]/']) {
    await assert.rejects(fetchPage(u, {}, 0), BlockedUrlError, u);
  }
});

test('SSRF guard does not block public addresses (regression)', async () => {
  const { isPrivateIp } = await import('./http.ts');
  for (const ip of ['8.8.8.8', '1.1.1.1', '185.88.1.1', '2606:4700::1111', '2a00:1450:4014:80b::200e']) assert.equal(isPrivateIp(ip), false, ip);
  for (const ip of ['127.0.0.1', '::ffff:7f00:1', '::ffff:127.0.0.1', '::127.0.0.1', '64:ff9b::7f00:1', 'fe80::1', 'fd12::1', '::1', '::']) assert.equal(isPrivateIp(ip), true, ip);
});
