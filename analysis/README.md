# Independent Cineplex ticket-volume study

Not part of the site, scraper, or frontend contract described in
`AGENTS.md` -- this is a standalone study built on top of the data those
pieces produce, specifically the fact that this repo's own git history
*is* a time series of Cineplex seat-map snapshots (one commit per scrape,
`github-actions[bot]`, roughly 12x/day). It has its own directory so it
can be deleted or ignored without touching the site.

## How it works

For every session at every theatre, Cineplex's seat map marks each seat
`A` (available), `O` (occupied), or `?` (unknown). A seat flipping
`A` -> `O` between two consecutive scrapes of the *same session* is read
as a ticket sold in that window; `O` -> `A` is read as a hold released /
refunded. Sessions are identified by `layoutKey` (Cineplex's
`vistaSessionId`), which is the one stable, unique-per-showtime key in the
data -- `areaCode` is explicitly *not* stable (see AGENTS.md's "Seat data"
section) so it's never used for this.

Seat positions are cross-referenced against that session's auditorium
`seatTypes` grid to split sold seats into standard / wheelchair /
companion / D-BOX, and each session's `formats` tags drive a rough price
estimate (see `price-model.mjs`) to turn ticket counts into a modeled $
figure.

```
extract-events.mjs  -- walks `git log`, diffs every session's seat grid
                        commit-to-commit, writes:
                          out/occupancy-events.csv   (sold/released events)
                          out/session-baselines.csv  (first-seen occupied counts)
price-model.mjs      -- editable base prices + surcharges
report.mjs           -- aggregates events into day/format/theatre rollups
                        + a modeled revenue total, writes:
                          out/daily-summary.csv
                          out/format-summary.csv
                          out/theatre-summary.csv
```

Run:

```sh
node analysis/extract-events.mjs   # 152 theatres x every commit in history --
                                    # a few minutes per week of history you have
node analysis/report.mjs
```

If you're running this from a shallow clone (common on CI/cloud checkouts,
including Claude Code on the web's default), `git log` will silently only
see however many recent commits were fetched -- run `git rev-parse
--is-shallow-repository` to check, and `git fetch --unshallow origin
master` to get the rest before trusting any date-range claim this tool
makes.

Re-run `extract-events.mjs` any time after new scrape commits land to pick
up more history -- it always walks the full git log from scratch, so
there's nothing to incrementally update.

## What this can and can't tell you, honestly

**This repo has 26 days of scrape history as of this writing** (Aug 31 -
Sept 26, 2026, 309 scrape commits, ~12-13/day, matching the schedule in
`.github/workflows/scrape.yml`). That's already enough to see real
day-to-day movement (an opening-weekend spike shows up clearly -- see
below), though "monthly trends" proper still wants more accumulated
history. It grows on its own as the scheduled scraper keeps running; just
re-run the two scripts above periodically to pick up more days.

**Ticket volume is a real, direct measurement**, not a guess: it's
literally counting seat-state transitions in your own data. Caveats:

- **Coverage**: as of this run, 100% of sessions across every theatre
  sampled had seat-level data (Cineplex's reserved-seating rollout appears
  to be effectively universal now), so the "general-admission sessions
  have no seat map" gap noted in the original conversation turned out not
  to matter in practice today. Worth spot-checking again as history grows.
- **`SCRAPE_MODE=quick` runs** (12 of the 13 daily runs) carry forward
  stale deep-window (>14 day out) entries unchanged rather than
  re-fetching them -- see AGENTS.md's "Quick vs. deep mode". That's
  correctly handled here (no diff = no phantom event), but it does mean
  far-future sessions' occupancy only actually updates on Thursday's deep
  run or once they roll inside the near window.
- **"Baseline" seats** (`session-baselines.csv`): the first time this tool
  ever sees a session, whatever's already `O` at that moment is history
  from before the observation window started and can't be attributed to a
  specific day -- it's reported separately, not folded into daily/weekly
  totals, so those totals don't overcount the very first run.
- Every number here is **net of released seats** (holds that got dropped),
  which are real but rare; a handful of sessions in the current data go
  slightly negative for a single interval for this reason.

**Revenue is a modeled estimate layered on top of measured volume, not a
measurement.** `price-model.mjs` prices sessions using rough adult-evening
list prices by primary experience type (Regular/UltraAVX/IMAX/ScreenX/
4DX/VIP), a 3D surcharge, and a D-BOX per-seat surcharge -- ballparked
from public reporting (see sources below), not Cineplex's real dynamic
pricing. It does **not** model: matinee/day-of-week pricing, age tiers
(student/senior/child), promotions ($5 Tuesdays, VIP Wednesdays, etc.),
or provincial tax. Treat the revenue output as order-of-magnitude, and
edit the constants in `price-model.mjs` if you have better numbers.
Several observed `experienceTypes` tags (`Recliner`, `Dolby Atmos`,
`70mm`, `Clubhouse`, `Early Access`, `Stars & Strollers`) aren't priced
separately -- a session carrying one of those alongside `Regular` is
priced as Regular, since there's no clear public evidence they carry a
separate surcharge.

Concessions are intentionally out of scope: there's nothing in this
dataset that reflects concessions in any way, so any number there would
be pure industry-average guesswork rather than inference from data.

## First full-history run's numbers, for reference

26 scrape days (Aug 31 - Sept 26, one partial day at the end), 152
theatres, 588,065 sold/released events on top of 166,724 tracked sessions:

- ~2,128,599 net tickets, ~$36.6M modeled ticket revenue chain-wide across
  the window (~$1.4M/day median, but far from flat day to day -- see
  below).
- Format mix by modeled revenue: Regular ~62%, UltraAVX ~14%, IMAX ~11%,
  VIP ~8%, the rest (Laser Projection/ScreenX/4DX) ~5% combined.
- Cineplex Cinemas Yonge-Dundas and VIP led all 152 theatres in modeled
  revenue over the window.
- **A real trend, not just noise**: daily tickets roughly triple from
  ~75k (Sept 1) to ~215k (Sept 5) before falling back to a ~50-85k/day
  baseline for the rest of the month. Attributing each day's tickets to
  the movie they were for shows why: Sept 4-6 is dominated by *Spider-Man:
  Brand New Day* (~105k tickets that weekend alone), *The Odyssey*
  (~91k), and *Coyote vs ACME* (~83k) -- a normal opening-weekend spike
  for a few tentpole releases, clearly visible in the seat-diff data with
  zero manual labeling.

Sanity check: extrapolated to a year this is the right order of magnitude
for Cineplex's actual historical Canadian box-office revenue -- but a
26-day window extrapolated to a year is not a forecast, just a
plausibility check that the model isn't off by 10x in either direction.

## Price sources (rough, Sept 2026)

- [Cineplex Ticket Prices Canada 2026](https://cinematicketprices.com/cineplex-ticket-prices/)
- [PriceListo: Cineplex Ticket Prices](https://www.pricelisto.com/prices/cineplex)
- Public reporting on Cineplex promotions (Daily Hive, MTL Blog, Narcity) for
  promotional-price context -- not used directly in the model, which prices
  at non-promotional adult-evening rates.
