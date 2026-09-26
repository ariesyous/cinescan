// Independent study tool, not part of the site/scraper/frontend contract.
//
// Walks this repo's own git history (github-actions[bot]'s scheduled
// "Update showtimes" commits) and reconstructs, for every session at every
// theatre, how its seat map changed scrape-to-scrape. A seat flipping
// "A" (available) -> "O" (occupied) between two consecutive snapshots of
// the same session is read as a ticket sold in that window; the reverse
// (a hold released) is read as a ticket refunded/released. This is the
// only ticket-volume signal available -- Cineplex's data never exposes an
// actual sales count or price, so this is inference from seat-map deltas,
// not a reported figure.
//
// Sessions are keyed by layoutKey (== vistaSessionId, per AGENTS.md), which
// is unique per showtime and stable across scrapes, unlike areaCode.
//
// Output: two CSVs under analysis/out/
//   - occupancy-events.csv   one row per session per commit-to-commit
//                            transition that changed seat state
//   - session-baselines.csv  one row per session the first time it's seen,
//                            recording how many seats were already occupied
//                            before this run's observation window started
//                            (can't be attributed to a specific interval)
//
// Usage: node analysis/extract-events.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = path.join(REPO_ROOT, "analysis", "out");
const MAX_BUFFER = 32 * 1024 * 1024;

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, maxBuffer: MAX_BUFFER, encoding: "utf8" });
}

const theatres = JSON.parse(readFileSync(path.join(REPO_ROOT, "data", "theatres.json"), "utf8"));

const commits = git(["log", "--format=%H|%aI", "--reverse"])
  .trim()
  .split("\n")
  .map((line) => {
    const [hash, authorDate] = line.split("|");
    return { hash, authorDate };
  });

console.log(`${commits.length} commits, ${theatres.length} theatres to walk`);

function csvField(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function csvRow(fields) {
  return fields.map(csvField).join(",") + "\n";
}

const eventRows = [
  csvRow([
    "theatreId", "theatreSlug", "theatreName", "layoutKey",
    "showDate", "showTime", "movieTitle", "formats",
    "prevObservedAt", "observedAt",
    "soldStandard", "soldWheelchair", "soldCompanion", "soldDBox", "soldUnknownType",
    "released",
  ]),
];
const baselineRows = [
  csvRow([
    "theatreId", "theatreSlug", "theatreName", "layoutKey",
    "showDate", "showTime", "movieTitle", "formats",
    "firstObservedAt", "occupiedAtFirstObservation", "totalSeats",
  ]),
];

// classify a flipped seat position using the auditorium's seatTypes grid
function seatTypeAt(seatTypesGrid, row, col) {
  if (!seatTypesGrid || row >= seatTypesGrid.length) return null;
  const line = seatTypesGrid[row];
  if (!line || col >= line.length) return null;
  const c = line[col];
  return c === "." ? null : c;
}

function countOccupied(seatsGrid) {
  let n = 0;
  for (const row of seatsGrid) for (const ch of row) if (ch === "O") n++;
  return n;
}

let processedTheatres = 0;
for (const theatre of theatres) {
  processedTheatres++;
  const relPath = theatre.file;
  // last-seen snapshot per layoutKey: { grid, observedAt, meta }
  const prevByLayoutKey = new Map();
  const seenLayoutKeys = new Set();

  for (const commit of commits) {
    let text;
    try {
      text = git(["show", `${commit.hash}:${relPath}`]);
    } catch {
      continue; // file didn't exist yet at this commit, or was untouched
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      continue; // fail-soft, same spirit as the scraper itself
    }

    const auditoriums = data.auditoriums || {};
    const observedAt = data.updatedAt || commit.authorDate;

    for (const day of data.days || []) {
      for (const movie of day.movies || []) {
        for (const session of movie.sessions || []) {
          const layoutKey = session.layoutKey;
          if (!layoutKey || !session.seats) continue;
          const grid = session.seats;
          const meta = {
            showDate: day.date,
            showTime: session.time,
            movieTitle: movie.title,
            formats: (session.formats || []).join("|"),
          };

          const prev = prevByLayoutKey.get(layoutKey);
          if (!prev) {
            if (!seenLayoutKeys.has(layoutKey)) {
              seenLayoutKeys.add(layoutKey);
              baselineRows.push(
                csvRow([
                  theatre.id, theatre.slug, theatre.name, layoutKey,
                  meta.showDate, meta.showTime, meta.movieTitle, meta.formats,
                  observedAt, countOccupied(grid),
                  grid.reduce((n, row) => n + row.length, 0),
                ])
              );
            }
            prevByLayoutKey.set(layoutKey, { grid, observedAt, meta });
            continue;
          }

          if (prev.grid.length === grid.length) {
            const seatTypesGrid = auditoriums[layoutKey]?.seatTypes;
            let soldStandard = 0, soldWheelchair = 0, soldCompanion = 0, soldDBox = 0, soldUnknown = 0, released = 0;
            for (let r = 0; r < grid.length; r++) {
              const oldRow = prev.grid[r];
              const newRow = grid[r];
              if (!oldRow || !newRow) continue;
              const len = Math.min(oldRow.length, newRow.length);
              for (let c = 0; c < len; c++) {
                const before = oldRow[c];
                const after = newRow[c];
                if (before === "A" && after === "O") {
                  const type = seatTypeAt(seatTypesGrid, r, c);
                  if (type === "S") soldStandard++;
                  else if (type === "W") soldWheelchair++;
                  else if (type === "C") soldCompanion++;
                  else if (type === "D") soldDBox++;
                  else soldUnknown++;
                } else if (before === "O" && after === "A") {
                  released++;
                }
              }
            }
            if (soldStandard || soldWheelchair || soldCompanion || soldDBox || soldUnknown || released) {
              eventRows.push(
                csvRow([
                  theatre.id, theatre.slug, theatre.name, layoutKey,
                  meta.showDate, meta.showTime, meta.movieTitle, meta.formats,
                  prev.observedAt, observedAt,
                  soldStandard, soldWheelchair, soldCompanion, soldDBox, soldUnknown,
                  released,
                ])
              );
            }
          }
          prevByLayoutKey.set(layoutKey, { grid, observedAt, meta });
        }
      }
    }
  }

  if (processedTheatres % 25 === 0) {
    console.log(`  ...${processedTheatres}/${theatres.length} theatres`);
  }
}

writeFileSync(path.join(OUT_DIR, "occupancy-events.csv"), eventRows.join(""));
writeFileSync(path.join(OUT_DIR, "session-baselines.csv"), baselineRows.join(""));
console.log(`wrote ${eventRows.length - 1} events, ${baselineRows.length - 1} session baselines to analysis/out/`);
