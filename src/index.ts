import { execFile } from 'node:child_process';
import { getConfig, loadConfig, saveConfig } from './config.ts';
import { startScheduler, state as scanState } from './scanner.ts';
import { startServer } from './server.ts';
import { dedupeAll, flush, reevaluateAll } from './store.ts';
import { msg } from './i18n.ts';

const cfg = loadConfig();
// Re-apply current filters/profile to stored jobs (rules may have changed since last run).
reevaluateAll(cfg);
// Installs that never clicked "Označit jako viděné": baseline = start of the last scan,
// so only that scan's jobs keep the NOVÉ badge (instead of every stored job).
if (!cfg.lastAcknowledgedAt && scanState.lastScanStartedAt) {
  cfg.lastAcknowledgedAt = scanState.lastScanStartedAt;
  saveConfig(cfg);
}
const merged = dedupeAll();
if (merged) console.log(msg('dedup', merged));
const port = Number(process.env.PORT ?? cfg.settings.port);

try {
  await startServer(port);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(msg('portBusy', port));
    process.exit(1);
  }
  throw err;
}

const url = `http://localhost:${port}`;
console.log(msg('banner', url, cfg.settings.scanIntervalMinutes));

if (getConfig().settings.openBrowser && !process.argv.includes('--no-open') && process.platform === 'darwin') {
  execFile('open', [url], () => {});
}

startScheduler();

const shutdown = () => {
  console.log(msg('shutdown'));
  try {
    flush();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
