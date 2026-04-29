# HowFar

How far is every address on this page from home? HowFar is a Chrome MV3
extension that finds postal addresses on any web page and shows walk,
drive, and cycle times from a base address you save once.

It calls Google Maps directly with **your** API key — no server in
between, no shared budget, nothing for the project to host. Setup takes
about 5 minutes via a built-in wizard the first time you open it.

```
          page
            │ extracts candidates
            ▼
   ┌──────────────────┐     ┌──────────────────────┐     ┌─────────────┐
   │  content script  │◄───►│   service worker     │◄──► │ Google Maps │
   │  scanner +       │     │  settings + cache +  │     │  Geocoding  │
   │  extractors +    │     │  budget tracker +    │     │  +          │
   │  annotator       │     │  Google client       │     │  Directions │
   └──────────────────┘     └──────────────────────┘     └─────────────┘
```

## Repo layout

```
extension/       MV3 extension — plain JS, no build step
  manifest.json
  service-worker.js          owns settings, cache, budget, Google calls
  shared/
    types.js                 statuses, modes
    messages.js              cross-context message types
    normalize.js             address normalization
    format.js                distance / duration formatters
    budget-tracker.js        chrome.storage-backed monthly cap
    provider-google.js       Geocoding + Directions client (SW-side)
  content/                   extractors, scanner, annotator, styles
  ui/                        popup + options pages (with first-run wizard)
  assets/                    icons

backend/         Optional dev/test server — not used by the public extension.
                 Kept for load-testing the provider against mocks and for
                 historical reference; you can ignore it for normal use.
```

## 1. Get a Google Maps API key

The extension's first-run wizard walks you through this, but here it is in
plain text:

1. Open the [Google Cloud Console — Maps Platform](https://console.cloud.google.com/google/maps-apis/start)
   and sign in.
2. Create a project (any name).
3. Enable **Geocoding API** and **Directions API** from the API Library.
4. APIs & Services → Credentials → **Create Credentials** → **API key**.
5. Click **Edit API key** → API restrictions → **Restrict key** →
   tick Geocoding API and Directions API. Save.

Google gives a **$200 free credit every month**, which is more than 28,000
geocoding calls + 10,000 directions calls. HowFar caches resolved addresses
locally for 15 minutes per page, so a normal browsing session uses a small
fraction of that. The in-app budget tracker (default cap: $180/month) is a
client-side speed-bump on top.

## 2. Load the extension

1. Visit `chrome://extensions/`.
2. Toggle **Developer mode** on.
3. Click **Load unpacked** and pick the `extension/` folder.
4. The wizard opens automatically. Walk through the four steps:
   welcome → get a key → paste & validate → set base address.
5. Done. Browse to any page with addresses and watch the badges appear.

To update after pulling new code: `chrome://extensions/` → reload icon on
the HowFar card, then refresh open tabs (Chrome doesn't re-inject content
scripts into already-open pages).

## What you'll see

Resolved addresses get an inline badge:

- `1.6 mi · 🚶 32 min · 🚗 8 min · 🚴 12 min` — fully resolved
- `…` — loading
- `unavailable` / `no route` / `not found` — failure modes

The popup lists every detected address on the current page with the same
information plus a per-mode breakdown. The header has a master ON/OFF
toggle (kill switch — when off, nothing scans and no API calls are made).

## Extraction order

The scanner tries sources in this priority and dedupes by normalized text:

1. `<address>` elements
2. JSON‑LD `PostalAddress`
3. HTML microdata (`itemtype` contains `PostalAddress`)
4. Map-service links (Google, Apple, OpenStreetMap, Bing)
5. Heuristic text match (street number + thoroughfare + optional postcode)

Only candidates Google geocodes successfully count as "matches".

## Performance rules (enforced in `content/scanner.js`)

- `MAX_CANDIDATES = 20` per page
- DOM rescans are debounced (`SCAN_DEBOUNCE_MS = 600`)
- Google never receives full page HTML — only short candidate strings
- Script/style/code/template/iframe/svg nodes are skipped
- Hidden elements (`display:none`, `visibility:hidden`, zero-size) are skipped
- Candidates are deduped by normalized address before sending

## Result statuses

Top-level address-resolution status: `ok`, `ambiguous`, `not_found`,
`error`, `paused`. Each entry inside `result.modes[mode]` carries its own
status: `ok`, `no_route`, or `error`. The extension also uses a local-only
`loading` state while a request is in flight.

## Free-tier safeguard

Google's Maps Platform gives **$200 of free credit per month** but does
not stop serving requests when you blow past it — it just bills you. To
avoid surprise charges, the extension keeps a client-side budget tracker
in `chrome.storage.local`:

1. Every Geocoding / Directions call is counted and multiplied by Google's
   list price ($5 / 1,000 = $0.005 per call).
2. When estimated monthly spend reaches your cap (default **$180**), the
   breaker trips.
3. With the breaker tripped, fresh addresses get a `paused` status — but
   anything in the 15-minute distance cache keeps rendering, so already-seen
   pages stay useful.
4. The popup and options page show a "Free-tier cap reached" banner.
5. The options page has a **Reset monthly counter** button so you can
   resume after raising your cap or rolling into a new month.

The breaker also trips instantly if Google itself responds with
`OVER_QUERY_LIMIT`, `OVER_DAILY_LIMIT`, `REQUEST_DENIED`,
`BILLING_NOT_ENABLED`, or HTTP 403/429.

For belt-and-braces protection, also set per-API daily quotas in the
Google Cloud Console and a billing budget alert — those are authoritative.
The in-app tracker is a fast circuit-breaker on top.

## Where your data lives

- **API key + base address + settings**: `chrome.storage.local`. Never
  leaves your machine except to `https://maps.googleapis.com`.
- **Page contents**: never sent anywhere. Only short candidate address
  strings reach Google.
- **HowFar itself**: no telemetry, no analytics, no servers.

## Optional: the dev backend

`backend/` is a TypeScript Express server with the same Google client
logic, kept around for load-testing the provider in isolation and for
anyone who wants a server-side deployment. **The public extension does
not use it.** If you want to run it anyway:

```bash
cd backend
cp .env.example .env
# put your Google Maps API key in .env
npm install
npm run dev
```

It listens on `http://localhost:8787`. See `backend/src/routes/` for the
HTTP surface.

## Local development tips

- Service-worker logs: `chrome://extensions/` → HowFar → **Service worker**
  link.
- Content-script logs: the test page's own devtools console.
- Reload after edits: extension card reload icon, then refresh open tabs.
- Tests: `cd extension && node --test test/` for extractor tests;
  `cd backend && npm test` for backend unit tests.
