# AGENTS.md

Guidance for AI coding agents working in this repo.

## What this project is

A static GitHub Pages site showing showtimes at every Cineplex theatre in
Canada (~152 theatres), every movie, every format (Regular, IMAX, UltraAVX,
ScreenX, 4DX, VIP, and modifiers like 3D/D-BOX/Laser Projection/Dolby
Atmos), filterable by format. No backend, no build step. See `README.md`
for a user-facing overview.

## Architecture

Three independent pieces, connected only through the JSON files in `data/`:

1. **`scripts/fetch-theatres.mjs`** (run manually, not scheduled) builds
   `data/theatres.json` — the manifest every other piece reads.
2. **`scripts/scrape.mjs`** (run on a schedule by GitHub Actions) reads
   `data/theatres.json`, hits Cineplex's API, and writes one
   `data/<slug>.json` per theatre.
3. **`index.html`/`app.js`/`style.css`** (served as-is by GitHub Pages) reads
   `data/theatres.json` and the selected theatre's data file client-side.
   Nothing server-side ever touches the frontend files.

There's no shared code between the scraper and the frontend — the JSON file
shape *is* the contract between them. If you change what the scraper writes,
check `app.js` for what it expects to read, and vice versa.

## Data model

**`data/theatres.json`** — array of `{ id, slug, name, city, province,
metro, file }`. `id` is Cineplex's internal `theatreId` (used in every API
call); `slug`/`file` are derived from the name; `metro` is
`GTA`/`Montreal`/`Vancouver`/`null`, hand-assigned by a `METRO_CITIES` list
in `fetch-theatres.mjs` and used by the frontend's region picker. Generated,
never hand-edited.

**`data/<slug>.json`** (one per theatre) — the scraper's output and the
frontend's per-theatre data source:

```jsonc
{
  "updatedAt": "2026-08-31T17:03:12.000Z",
  "theatre": { "id": 7402, "name": "Scotiabank Theatre Toronto" },
  "auditoriums": {
    // keyed by vistaSessionId (see "Seat data" below), NOT by room/areaCode
    "123456": { "totalRows": 12, "totalColumns": 20, "rowLabels": [...], "seatTypes": [...] }
  },
  "days": [
    {
      "date": "2026-08-31",
      "movies": [
        {
          "title": "...", "poster": "...", "runtimeMinutes": 128,
          "sessions": [
            { "time": "19:30", "formats": ["IMAX", "3D"], "ticketUrl": "...",
              "layoutKey": "123456", "seats": ["....AAOO....", ...] }
          ]
        }
      ]
    }
  ]
}
```

A theatre's file is only rewritten if at least one date request for it
succeeded that run (see "Fail-soft" below) — a bad run leaves the previous
good file untouched rather than emptying it.

## Operating the scraper

### Two windows, two costs

Cineplex only publishes a contiguous ~10-14 day window of showtimes per
theatre under normal circumstances. Big releases also open **IMAX** advance
ticket sales for scattered dates much further out (observed up to ~6 months
ahead). Probing far ahead for all 152 theatres × all formats would be huge,
so the scraper splits into two phases (see the reasoning comment at the top
of `scripts/scrape.mjs`):

- **Near window** (`NEAR_DAYS_AHEAD = 14`): every theatre, every format.
  Matches Cineplex's normal published window.
- **Deep window** (`DEEP_DAYS_AHEAD = 180`): only theatres that turned out
  to have an IMAX or UltraAVX screen in that run's near window results, and
  only IMAX/UltraAVX sessions are kept from it
  (`PREMIUM_EXPERIENCE_TYPES = new Set(["IMAX", "UltraAVX"])`). This is what
  catches advance IMAX/UltraAVX tentpole sales without a full deep scan.

### Quick vs. deep mode

`SCRAPE_MODE` env var controls whether the deep phase runs at all:

- `SCRAPE_MODE=quick` — near window only. Before writing each theatre's
  file, `loadStaleDeepWindowData` reads that theatre's *existing*
  `data/<slug>.json` and carries forward any `days` entries dated past the
  near window (plus their `auditoriums` entries) so a quick run can't
  silently wipe out the last deep run's far-future IMAX dates. Those dates
  roll into the near window and refresh normally as they get close.
- `SCRAPE_MODE=deep` (or unset — this is the default for a bare local run)
  — runs both phases, i.e. the original full behavior.

### Schedule (`.github/workflows/scrape.yml`)

Thirteen fixed-UTC cron entries (chosen to land near hourly ET times listed
below; they drift ~1hr across the EST/EDT boundary — that drift is
accepted, not corrected for, per a deliberate tradeoff against the
complexity of DST-aware scheduling): the near window runs 12 times a day,
and the deep window rides along with one of those (Thursday 1pm) instead of
running separately.

| Cron | Approx ET | Mode |
|---|---|---|
| `0 12 * * *` | 8am, every day | quick |
| `0 17 * * 1,2,3,5,6,0` | 1pm, every day except Thursday | quick |
| `0 17 * * 4` | 1pm Thursday | deep |
| `0 18 * * *` | 2pm, every day | quick |
| `0 19 * * *` | 3pm, every day | quick |
| `0 20 * * *` | 4pm, every day | quick |
| `0 21 * * *` | 5pm, every day | quick |
| `0 22 * * *` | 6pm, every day | quick |
| `0 23 * * *` | 7pm, every day | quick |
| `0 0 * * *` | 8pm, every day | quick |
| `0 1 * * *` | 9pm, every day | quick |
| `0 2 * * *` | 10pm, every day | quick |
| `0 5 * * *` | 1am, every day | quick |

A "Determine scrape mode" step maps `github.event.schedule` to
`SCRAPE_MODE` for cron-triggered runs (the Thursday-1pm string → `deep`,
either other cron string → `quick`); for manual `workflow_dispatch` runs it
uses the `mode` input instead (defaults to `quick`).

After the scraper runs, the workflow commits any changed `data/*.json`
files as `github-actions[bot]` and pushes. `concurrency: group: scrape` with
`cancel-in-progress: false` prevents two runs (e.g. a manual dispatch
overlapping a scheduled one) from racing on that commit/push — a second
trigger queues instead of running concurrently.

### Running it yourself

Requires `CINEPLEX_SUBSCRIPTION_KEY` in the environment (copy
`.env.example` to `.env` and fill in a real value, then load it with
`node --env-file=.env`, or export it in your shell). The scraper throws
immediately if it's unset.

```sh
node --env-file=.env scripts/scrape.mjs                    # full near+deep scrape (slow, several minutes)
SCRAPE_MODE=quick node --env-file=.env scripts/scrape.mjs   # near window only (fast)
```

Or from GitHub: Actions tab → "Scrape Cineplex showtimes" → "Run workflow",
choosing `quick`/`deep`; or `gh workflow run scrape.yml -f mode=deep`. Use
`gh run watch` / `gh run view --log` to follow a run, and
`gh run list --workflow=scrape.yml` to see recent runs.

`scripts/fetch-theatres.mjs` (regenerates `data/theatres.json`) is *not* on
any schedule — re-run it by hand only when a theatre opens or closes.

## Seat data

For sessions that are individually reservable online (`seatDataEligible`:
reserved seating, bookable online, not sold out, has both
`vistaSessionId` and `areaCode`), the scraper fetches and compacts a seat
map:

- **Cache key is `vistaSessionId`, not `areaCode`.** Cineplex's `areaCode`
  is not a stable per-auditorium id — it's routinely reused across
  unrelated showtimes/rooms at the same theatre. Only `vistaSessionId`
  correctly identifies a specific showtime's seat layout, so
  `auditoriums` in the output is keyed by it (as a string, called
  `layoutKey` on each session).
- **D-BOX seats** live in a separate `dboxSeats` section of the raw layout
  response, not in `standardSeats`, and aren't distinguishable via the
  seat's own `type` field. `buildMergedRows` in `scrape.mjs` merges them
  into the standard seat grid using `dboxSeats.top`/`left`/`areaWidth` —
  see the comment above that function for the coordinate-math reasoning
  (verified empirically against real layouts, not from any Cineplex docs).
- Output is compacted to strings for size: `seatTypes` is one character
  per column per row (`S`/`W`/`C`/`D` for standard/wheelchair/companion/
  D-BOX, `.` for no seat), and each session's `seats` is the same grid with
  `A`/`O`/`?` for available/occupied/unknown.
- Seat-layout fetches are deduped per `vistaSessionId` within a run
  (`getLayout`'s promise cache) since layout is static per showtime while
  availability isn't.

## Constraints to respect

- **The Cineplex API is unofficial and reverse-engineered** (no public
  docs; the subscription key lives in Cineplex's own public JS bundle, so
  Cineplex — not Aries — controls whether it can ever be rotated). It's
  supplied at runtime via the `CINEPLEX_SUBSCRIPTION_KEY` env var (a GitHub
  Actions repo secret in CI; see `.env.example` for local runs) rather than
  hardcoded, to keep it out of the current source tree even though it isn't
  a credential Aries can rotate. Don't assume its shape is stable. Fail-soft
  behavior to preserve in any changes:
  - A single date request failing is caught and logged, not fatal
    (`processDate`'s try/catch).
  - A theatre where *every* date request failed writes nothing, leaving
    its last known-good file untouched (`writeTheatreFile`'s
    `successCount === 0` check), without aborting other theatres.
  - The process only exits non-zero if literally every theatre failed
    entirely (`main`'s `anySucceeded` check).
- **Request volume is a real constraint at 152 theatres.** Don't casually
  widen `NEAR_DAYS_AHEAD`/`DEEP_DAYS_AHEAD`, or add more formats to
  `PREMIUM_EXPERIENCE_TYPES` (currently IMAX and UltraAVX) — see the
  reasoning comment at the top of `scripts/scrape.mjs`. Including
  UltraAVX/VIP in the deep probe was tried and reverted once already
  because they're common enough at regular theatres to blow the deep-probe
  job count back up to full scale; UltraAVX was later deliberately
  re-added anyway to catch UltraAVX tentpole advance sales, accepting that
  higher request volume — VIP remains excluded. The deep probe is also only
  run once a week (Thursday), not every scrape — see "Quick vs. deep mode"
  above — for the same cost reason.
- Format tags are Cineplex's raw `experienceTypes` strings, used as-is
  rather than mapped to a smaller taxonomy — new tags Cineplex adds show up
  automatically as filterable/badge-able without code changes (falling back
  to a neutral badge color until a `--tag-*` CSS variable is added for them
  in `style.css`).
- No build step. Don't add bundlers, TypeScript compilation, or frameworks
  unless explicitly asked — the site is meant to stay simple enough to
  deploy by just pushing to `master`.
- GitHub Pages serves the `master` branch root directly. Any file at repo
  root is publicly served as-is — this is a public repo, so don't add
  anything (real API keys beyond the already-public Cineplex one, personal
  data, etc.) that shouldn't be world-readable.

## Layout reference

- `index.html`, `style.css`, `app.js` — the frontend. Plain HTML/CSS/vanilla
  JS on purpose. `app.js` builds a three-level drill-down picker from
  `data/theatres.json`: region buttons (GTA/Montreal/Vancouver/Everywhere
  Else, from `metro`) → area buttons (city, or province under Everywhere
  Else) → a persistent theatre list for that area, with a breadcrumb to jump
  back up (`currentRegion`/`currentArea` state, `renderNav`/`selectTheatre`).
  A search box (`renderTheatreDropdown`/`setupTheatrePicker`) is an
  alternate way to jump straight to a theatre, kept in sync via
  `selectTheatre`. Scotiabank Theatre Toronto is the default shown on load,
  matched by `theatreId` 7402 (not by slug, since slugs are auto-generated).
  Also builds the format filter bar and renders the calendar from the
  selected theatre's data file; session chips carry `session.formats` as
  color-coded badges, toggled by the filter bar.
- `scripts/scrape.mjs` — see "Operating the scraper" and "Seat data" above.
- `scripts/fetch-theatres.mjs` — regenerates `data/theatres.json` from
  Cineplex's theatre-list endpoint. Also assigns each theatre's `metro`
  field from a hand-maintained `METRO_CITIES` list — add a city there if a
  metro area's frontend coverage needs to expand.
- `data/theatres.json`, `data/*.json` — see "Data model" above. Generated;
  don't hand-edit.
- `.github/workflows/scrape.yml` — see "Schedule" above.

## Testing changes

- Run `node scripts/scrape.mjs` (or `SCRAPE_MODE=quick node scripts/scrape.mjs`
  for a much faster near-window-only pass) locally to regenerate `data/*.json`
  and sanity-check the output.
- Serve the repo root with any static file server (e.g. `npx serve` or
  `python -m http.server`) and open it in a browser to check the UI.
- There is no automated test suite. When changing scrape/write logic,
  spot-check a real theatre's `data/<slug>.json` diff (especially around
  `SCRAPE_MODE=quick`'s carry-forward behavior — deep-window days shouldn't
  disappear or duplicate across a quick run) rather than trusting it blind.
