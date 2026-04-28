# HowFar

How far is every address on this page from home? HowFar is a Chrome MV3
extension that finds postal addresses on any web page you visit and shows
walk, drive, and cycle times from a base address you save once.

```
          page
            │ extracts candidates
            ▼
   ┌──────────────────┐     ┌──────────────────────┐
   │  content script  │◄───►│   service worker     │◄──► backend API
   │  scanner +       │     │  settings + cache +  │     (Google)
   │  extractors +    │     │  orchestration       │
   │  annotator       │     └──────────────────────┘
   └──────────────────┘
```

## Repo layout

```
extension/       MV3 extension — plain JS, no build step
  manifest.json
  service-worker.js
  shared/        messages, normalization, types shared across contexts
  content/       extractors, scanner, annotator, styles
  ui/            popup + options pages
  assets/        icons

backend/         TypeScript service that talks to the maps provider
  src/
    index.ts
    routes/
      resolveBase.ts
      resolveDistances.ts
    providers/
      types.ts       DistanceProvider interface
      google.ts      Google Maps implementation
    utils/
      cache.ts format.ts normalize.ts
```

## 1. Run the backend

```bash
cd backend
cp .env.example .env
#  put your Google Maps API key into .env (Geocoding API + Directions API)
npm install
npm run dev
```

It listens on `http://localhost:8787`.

Endpoints:
- `POST /resolve-base` — `{ "address": "..." }`
- `POST /resolve-distances` — `{ base, modes, units, candidates: [...] }`
  - `modes` is an array of `"walk" | "drive" | "cycle"` (defaults to all three).
  - Legacy `{ mode: "walk" }` is still accepted.
  - Each result returns a `modes` map with per-mode `{ status, distanceMeters,
    durationSec, displayDistance, displayDuration }`. Walking distance is
    promoted to the top-level `distanceMeters` / `displayDistance` for compact
    UIs.
- `GET  /budget` — current month's estimated Google Maps spend, cap, counts,
  and whether the breaker has tripped. Also surfaces `persistError` if the
  counter file is unwritable.
- `POST /budget/reset` — zero the counter and clear the tripped flag.
  Requires the `X-WDF-Admin-Token` header to match `BUDGET_ADMIN_TOKEN`. When
  no env token is set, requests from `127.0.0.1` / `::1` are allowed so
  local development stays frictionless.
- `GET  /admin/token` — loopback-only. Returns the auto-generated admin
  token so the extension's options page can pick it up without the operator
  copy-pasting. Returns 403 from non-loopback IPs or when an env token is
  configured.
- `GET  /health` — simple status (also includes current budget usage and
  any persistence warnings).

The backend keeps an in-memory TTL cache keyed by `basePlaceId + normalized
candidate text + sorted-mode-set + units`. Cache TTL defaults to 15 minutes.
The provider layer (`DistanceProvider`) is an interface — swap
`GoogleDistanceProvider` for another vendor without touching the routes.

## 2. Load the extension

1. Visit `chrome://extensions/`.
2. Toggle "Developer mode" on.
3. Click "Load unpacked" and pick the `extension/` folder.
4. The toolbar icon appears. Right-click it → "Options".
5. Enter a base address (e.g. `221B Baker Street, London`), set units, save.
   The options page will show the canonical address + coordinates returned
   by the backend.

Now open any page that contains postal addresses. You should see small
badges appear next to each detected address:

- `1.6 mi · 🚶 32m · 🚗 8m · 🚴 12m` — resolved (modes you enabled in options)
- `… ` — loading
- `unavailable` / `no route` / `not found` — failure modes

## Extraction order

The scanner tries sources in this priority and dedupes by normalized text:

1. `<address>` elements
2. JSON‑LD `PostalAddress`
3. HTML microdata (`itemtype` contains `PostalAddress`)
4. Map-service links (Google, Apple, OpenStreetMap, Bing)
5. Heuristic text match (street number + thoroughfare + optional postcode)

Only candidates the backend geocodes successfully count as "matches".

## Performance rules (enforced in `content/scanner.js`)

- `MAX_CANDIDATES = 20` per page
- DOM rescans are debounced (`SCAN_DEBOUNCE_MS = 600`)
- The backend never receives full page HTML — only the short candidate strings
- Script/style/code/template/iframe/svg nodes are skipped
- Hidden elements (`display:none`, `visibility:hidden`, zero-size) are skipped
- Candidates are deduped by normalized address before sending

## Non-goals for v1

No OCR, no PDFs, no rendered maps, no turn-by-turn instructions, no
cross-origin iframe support, no LLMs.

## Provider abstraction

`backend/src/providers/types.ts` defines the interface:

```ts
type TravelMode = "walk" | "drive" | "cycle";

interface DistanceProvider {
  resolveBaseAddress(input: string): Promise<BaseLocation>;
  resolveCandidateAddresses(inputs: Candidate[]): Promise<ResolvedCandidate[]>;
  getDistances(
    base: BaseLocation,
    destinations: ResolvedCandidate[],
    modes: TravelMode[],
    units: "metric" | "imperial"
  ): Promise<DistanceResult[]>;
}
```

Drop a new class beside `google.ts` and wire it in `index.ts`.

## Result statuses

Top-level address-resolution status: `ok`, `ambiguous`, `not_found`, `error`.
Each entry inside `result.modes[mode]` carries its own status: `ok`,
`no_route`, or `error`. The extension additionally uses the local-only
`loading` state while a request is in flight.

## Free-tier safeguard

Google's Maps Platform gives every account a **$200 free credit** each month
but does not stop serving requests when it runs out — it just bills you. To
avoid surprise charges, the backend keeps a client-side budget tracker:

1. Every Geocoding / Directions call is counted and multiplied by a
   per-call price (configurable in `.env`; defaults match Google's list price
   of $5 / 1,000 = $0.005 per call).
2. When estimated monthly spend reaches `BUDGET_MONTHLY_USD_CAP` (default
   **$180**, leaving a small buffer under the $200 credit), the breaker trips.
3. With the breaker tripped, all `/resolve-*` routes return HTTP `429`
   `{ "code": "quota_exhausted" }` *without* calling Google.
4. The extension watches for that response, pauses scanning on every tab,
   and shows a "Free-tier cap reached" banner in the popup and options page.
5. The Options page has a **Reset monthly quota** button (and the backend
   exposes `POST /budget/reset`) so you can resume after raising your cap,
   paying the bill, or rolling into a new month.

The counter lives in `.budget.json` next to the backend (configurable via
`BUDGET_FILE`). It survives restarts and automatically rolls over on the 1st
of each month. The breaker also trips instantly if Google itself responds
with `OVER_QUERY_LIMIT`, `OVER_DAILY_LIMIT`, `REQUEST_DENIED`,
`BILLING_NOT_ENABLED`, or an HTTP 403/429 at the transport layer.

### Partial results when the breaker trips mid-request

If a `/resolve-distances` call partially exhausts the budget, the backend
still returns HTTP 200 with whatever results it managed to finish, and
marks the rest with `status: "paused"` (plus a top-level `paused: true`).
The extension renders those entries with a distinct "paused" badge and
keeps serving cached distances for addresses it has already resolved.

### Reset authentication

`POST /budget/reset` is gated:

- If `BUDGET_ADMIN_TOKEN` is set, callers must send
  `X-WDF-Admin-Token: <that value>`.
- If `BUDGET_ADMIN_TOKEN` is unset, the backend generates one at first boot
  and writes it into `.budget.json`. Local requests (loopback IP) are allowed
  without a header — convenient for dev — but any remote request still needs
  the token.
- On localhost only, `GET /admin/token` returns the generated value so the
  Options page can auto-populate its "Admin token" field.

In a shared / hosted deployment, **always set `BUDGET_ADMIN_TOKEN`
explicitly** and set `ALLOWED_ORIGINS` to the exact `chrome-extension://…`
origin — never `*`.

For belt-and-braces protection, also set per-API daily quotas in the Google
Cloud Console and a billing budget alert — those are authoritative. This
in-app tracker is a fast circuit-breaker on top.

## Local development tips

- The service worker logs live under `chrome://extensions/` → the
  extension card → "Service worker" (Inspect views).
- Content-script logs appear in the page's own devtools console.
- To point the extension at a non-localhost backend, set it in Options →
  "Backend URL" **and** add the host to `host_permissions` in
  `manifest.json`.
