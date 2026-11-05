# Testing

## Automated

```bash
npm run typecheck   # tsc --noEmit (strict, erasableSyntaxOnly)
npm test            # node:test, src/*.test.ts – no extra dependencies
```

`src/core.test.ts` covers pure logic and needs no network:

- **`parseSalary`:** CZK ranges (including the zero-width joiners from Jobs.cz), the `k` / `tis.` suffixes vs. „Kč", periods (hour, man-day, month, year), open ranges („od" / „až")
- **`isRelevant`:** role include / exclude rules, native iOS/Android vs. React Native, generic titles that need a core skill, backend/ML/platform exclusions
- **`evaluate`:** city × onsite / hybrid / remote, regions in titles, „EU-wide" in descriptions, the salary threshold, "Global" only as a location
- **`computeMatch`:** a core stack scores high, avoided tech is penalised, an unknown stack gives `null`
- **Dedup:**
  - the same offer is matched across portals
  - different companies never collide (Česká spořitelna vs. Česká pojišťovna, ČEZ vs. ČEZ Distribuce…)
  - the provisional (slug) flow
- **Enrichment:** URL classification, contact filtering (placeholders, agencies, strict mode for non-job pages)
- **SSRF guard:** loopback, private, link-local, IPv4-mapped / compatible / NAT64 IPv6, `file:` and dotless hosts are blocked; public v4/v6 addresses are allowed

The tests read `data/rates.json` if it exists (ČNB rates). Without it they fall back to built-in rates, and the results don't depend on that.

## Manual / integration

Adapters depend on third-party HTML and APIs, so they have no unit tests. To check them:

```bash
npm run scan              # all enabled sources, prints counts and the top 15
npm run scan linkedin     # a single source (id from the Sources tab / data/config.json)
```

What to look for in the output or in the dashboard's **Zdroje** tab:

- **`0 staženo` (0 fetched)** for a source that used to return data: the portal changed its markup, so update its selectors in `src/sources/`.
- **`HTTP 429`:** you're being rate-limited. Increase `HOST_GAP_MS` in `src/http.ts` or lower `maxPages`.
- **`HTTP 403`** on details (e.g. We Work Remotely): expected. The description comes from the feed.

Quick API checks while the server is running:

```bash
curl -s localhost:4321/api/state | head -c 300
curl -s -X POST -H 'Content-Type: application/json' -H 'Origin: http://evil.com' localhost:4321/api/ack   # → 403
```
