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
node analysis/extract-events.mjs   # ~3 min: 152 theatres x every commit in history
node analysis/report.mjs
```

Re-run `extract-events.mjs` any time after new scrape commits land to pick
up more history -- it always walks the full git log from scratch, so
there's nothing to incrementally update.

## What this can and can't tell you, honestly

**This repo currently has ~4.5 days of scrape history** (Sept 22-26,
2026, 50 commits). That is enough to prove the mechanism works -- see the
numbers below -- but it is nowhere near enough for the "daily/weekly/
monthly trends" framing this study started from. Trends need weeks to
months of accumulated commits. The scraper is already running on schedule
(`.github/workflows/scrape.yml`), so this grows on its own; re-run the two
scripts above periodically as it does.

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

## First run's numbers, for reference

5 scrape days (Sept 22-26, one partial day), 152 theatres, 96,162
sold/released events on top of 62,486 tracked sessions:

- ~313,591 net tickets, ~$5.5M modeled ticket revenue chain-wide across
  the window (~$1.1M/day on the 4 complete days -- Sept 26 is partial,
  cut off mid-day when this was run).
- Format mix by modeled revenue: Regular ~58%, UltraAVX ~18%, VIP ~11%,
  IMAX ~8%, the rest (ScreenX/Laser Projection/4DX) ~5% combined.
- Scotiabank Theatre Toronto led all 152 theatres in modeled revenue.

Sanity check: extrapolated to a year this is the right order of magnitude
for Cineplex's actual historical Canadian box-office revenue -- but a
4.5-day window extrapolated to a year is not a forecast, just a
plausibility check that the model isn't off by 10x in either direction.

## Price sources (rough, Sept 2026)

- [Cineplex Ticket Prices Canada 2026](https://cinematicketprices.com/cineplex-ticket-prices/)
- [PriceListo: Cineplex Ticket Prices](https://www.pricelisto.com/prices/cineplex)
- Public reporting on Cineplex promotions (Daily Hive, MTL Blog, Narcity) for
  promotional-price context -- not used directly in the model, which prices
  at non-promotional adult-evening rates.
