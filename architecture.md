# Architecture

The app is a single Node process: Node ≥ 22.18, with TypeScript run through native type stripping, so there's no build step. The only runtime dependency is [`cheerio`](https://cheerio.js.org/) for HTML parsing.

```
npm start ─► src/index.ts
              ├─ loadConfig()     data/config.json (defaults in src/config.ts, new default sources merged once)
              ├─ reevaluateAll()  re-applies the current filters / stack match to stored jobs
              ├─ dedupeAll()      re-validates and merges cross-portal duplicates
              ├─ startServer()    src/server.ts  → 127.0.0.1:4321 (REST API + static dashboard + SSE)
              └─ startScheduler() src/scanner.ts → scan now, then every N minutes
```

## Scan flow

```
scanner.runScan()
  └─ all enabled sources in parallel (one host = one serial queue, see http.ts throttling)
       adapter.list(url)        src/sources/*  → RawJob[]
       filters.isRelevant()     role check on the title; irrelevant listings are never stored
       store.upsert()           id = sourceId:sourceJobId; cross-portal dedup via dupKey + sameOffer();
                                change log (title / salary / location); evaluate() + computeMatch()
       store.flush()            atomic write of data/jobs.json after the list phase
       adapter.detail()         full description (shared budget maxDetailFetchesPerScan;
                                order: provisional → passing → filtered-out)
       store.markGone()         only when every URL of the source loaded and returned something
  └─ macOS notification (osascript via execFile, no shell) for new jobs with verdict "ok"
  └─ SSE events → the dashboard refreshes progressively
  └─ after the scan, outside the scan lock: enrichBatch() (opt-in original-posting lookup)
```

**Provisional jobs.** StartupJobs is listed from its sitemap, so the URL slug serves as a placeholder title. After the detail is fetched, the real title is checked with `isRelevant` again and deduplicated. If it turns out irrelevant, or it's a duplicate of a job we already have, it becomes a hidden *tombstone* (`hidden: 'irrelevant' | 'merged'`), so it isn't re-created on every scan.

## Modules

| File | Responsibility |
| --- | --- |
| `src/types.ts` | Domain types (`RawJob`, `Job`, `SourceConfig`, `AppConfig`, `Enrichment`…) |
| `src/config.ts` | Example presets (`java-fullstack`, `react-native`: profile, title rules, search URL overrides) selected by `DEFAULT_PRESET`; shared filters and default sources; load/save with a per-section merge of defaults; one-off migration of new default sources |
| `src/fsutil.ts` | `data/` paths, atomic JSON writes, backup of corrupted files |
| `src/http.ts` | `fetch` with UA, timeout, retries (429/5xx), per-host politeness gaps, SSRF guard (manual redirects, every hop validated) |
| `src/salary.ts` | Salary text parser (`k`, `tis.`, ranges, periods), ČNB exchange rates (12 h cache), conversion to CZK/month |
| `src/filters.ts` | Title relevance, work-mode detection, location and salary verdicts with reasons |
| `src/match.ts` | Technology dictionary (regexes), stack detection, scoring, tag import from free text |
| `src/store.ts` | In-memory `Map` + persistence, upsert, title/company normalisation, dedup, change log, statuses, gone/tombstones |
| `src/enrich.ts` | Original-posting lookup (ATS / redirect / JSON-LD / domain guess / career page) and published contacts; URL classification `ats / microsite / company / external / portal`; agency detection |
| `src/scanner.ts` | Scan orchestration, run state (`data/scan-state.json`), scheduler, notifications, enrichment batches |
| `src/server.ts` | REST API, input validation, Host/Origin guards, SSE, static files |
| `src/sources/index.ts` | Adapter registry (label, hint, `list`, optional `detail`) |
| `src/sources/czech.ts` | Jobs.cz, Prace.cz, Profesia.cz/.sk (HTML) |
| `src/sources/linkedin.ts` | LinkedIn guest search + posting detail |
| `src/sources/nofluffjobs.ts` | No Fluff Jobs (Angular SSR state) |
| `src/sources/remote.ts` | Remote OK, Remotive, Himalayas, Jobicy, Arbeitnow (JSON APIs) |
| `src/sources/more.ts` | StartupJobs (sitemap), Jobstack.it, Easy-práce.cz, JobsContact.cz, ReactJobs.io, JS Guru Jobs |
| `src/sources/ats.ts` | Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee: public board APIs, with the token parsed from a careers or API URL |
| `src/sources/eu.ts` | Generic JSON-LD listing (Djinni), Remote Rocketship, Remote.com, Arc.dev, Bulldogjob, EuroTechJobs, Landing.jobs, Working Nomads, FrontendEngineers, Jooble (API key from env) |
| `src/sources/generic.ts` | RSS/Atom, generic HTML with CSS selectors |
| `src/sources/util.ts` | HTML → text, JSON-LD `JobPosting` mapping, generic detail fetch |
| `src/i18n.ts` | Server messages (terminal logs, desktop notifications) in the configured language |
| `src/cli-scan.ts` | `npm run scan`: delegates to the running dashboard if there is one |
| `public/` | Dashboard: vanilla JS, an `el()` helper that only ever uses `textContent`, CSS with light/dark themes |
| `public/i18n.js` | UI dictionary (cs/en), plural forms, and `tr()`, which translates Czech strings produced by the server (filter reasons, lookup steps, contact notes, API errors), so stored data stays language-neutral |

## REST API

The API is local only. Writes require `Content-Type: application/json` and a same-origin `Origin`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/state` | Config, scan state, adapters, known technologies |
| GET | `/api/jobs` | All visible jobs (description trimmed to an excerpt) |
| GET / PATCH | `/api/jobs/:id` | Full detail / update `status`, `note` |
| POST | `/api/jobs/:id/enrich` | Run the original-posting lookup now |
| POST | `/api/scan` | `{ sourceId? }`: start a scan |
| POST | `/api/ack` | Mark everything as seen (resets the NEW badges) |
| PUT | `/api/profile`, `/api/filters`, `/api/settings` | Save + re-evaluate |
| POST | `/api/defaults/filters` | Reset filters to defaults |
| POST | `/api/language` | `{ language: 'cs' \| 'en' }` |
| POST | `/api/profile/import` | `{ text }` → detected technologies |
| POST / PUT / DELETE | `/api/sources[/:id]` | Manage sources |
| GET | `/api/events` | SSE: `scan-start`, `source`, `scan-end`, `enriched` |

## Adding a new portal

1. Write `list(url, maxPages): Promise<RawJob[]>` in `src/sources/`. Use a stable `sourceJobId`, strip tracking parameters from URLs, and set `workMode` and `salary` when the source provides them. Prefer an official API, embedded JSON (`__NEXT_DATA__`, JSON-LD) or server-rendered HTML, in that order, and check the site's terms and robots.txt.
2. Add the type to `AdapterType` in `src/types.ts` and an entry to `ADAPTERS` in `src/sources/index.ts`, with a `detail` function if the listing has no description.
3. Optionally add a default source to `DEFAULT_SOURCES` in `src/config.ts`. Existing installs get it once, through the `seenDefaultSources` migration.
4. Add the portal's host to `PORTAL_HOST` in `src/enrich.ts`, so its pages are never treated as an employer's original posting.
