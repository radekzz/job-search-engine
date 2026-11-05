// One-off scan without the dashboard: `npm run scan [sourceId]`
import { loadConfig } from './config.ts';
import { runScan } from './scanner.ts';
import { visibleJobs } from './store.ts';
import { msg } from './i18n.ts';

const cfg = loadConfig();
const sourceId = process.argv[2];
const port = Number(process.env.PORT ?? cfg.settings.port);

// If the dashboard is running, delegate to it – two processes writing data/jobs.json would overwrite each other.
const running = await fetch(`http://localhost:${port}/api/state`, { signal: AbortSignal.timeout(1500) }).then(
  (r) => r.ok,
  () => false,
);
if (running) {
  const res = await fetch(`http://localhost:${port}/api/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sourceId ? { sourceId } : {}),
  });
  console.log(
    res.ok
      ? msg('cliDelegated', `http://localhost:${port}`)
      : msg('cliDelegateFail', ((await res.json()) as { error?: string }).error),
  );
  process.exit(res.ok ? 0 : 1);
}

await runScan(sourceId);
const visible = visibleJobs().filter((j) => j.evaluation.verdict !== 'fail' && j.status !== 'rejected');
console.log(msg('cliSummary', visibleJobs().length, visible.length));
for (const j of visible.sort((a, b) => (b.match.score ?? -1) - (a.match.score ?? -1)).slice(0, 15)) {
  console.log(`  ${String(j.match.score ?? '–').padStart(3)}%  ${j.title} · ${j.company ?? ''} · ${j.location ?? ''} · ${j.sourceName}`);
}
