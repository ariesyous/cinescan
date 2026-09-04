// Scrapes Cineplex's undocumented theatrical API for showtimes at every
// theatre listed in data/theatres.json and writes one data/<slug>.json per
// theatre. Keeps every movie/format (Regular, IMAX, UltraAVX, ScreenX,
// 4DX, VIP, and their modifiers like 3D/D-BOX/Laser Projection/Dolby
// Atmos), tagging each session with Cineplex's raw experienceTypes.
//
// The API is unofficial (reverse-engineered from Cineplex's own JS bundle).
// If it starts failing entirely for a theatre, we skip writing that
// theatre's file so we never clobber its last known-good data with
// empty/broken output.

const SUBSCRIPTION_KEY = process.env.CINEPLEX_SUBSCRIPTION_KEY;
if (!SUBSCRIPTION_KEY) {
  throw new Error("CINEPLEX_SUBSCRIPTION_KEY is required");
}
const API_BASE = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1";
const THEATRES_PATH = new URL("../data/theatres.json", import.meta.url);

// Cineplex normally publishes a contiguous window of regular showtimes for
// every theatre (~10-14 days). Big releases also open advance ticket sales
// for IMAX/UltraAVX tentpole events on scattered dates further out, but in
// practice not much beyond a few months ahead. Probing a full year for every
// one of Canada's 152 theatres is prohibitively expensive, so we only do
// that deep probe for theatres that actually have an IMAX or UltraAVX
// screen (discovered from the near window), cap it at 6 months instead of a
// full year, and only keep IMAX/UltraAVX sessions from the deep window —
// every other format (including ScreenX/4DX/VIP) is only probed within the
// near window, same as Regular. (UltraAVX was previously tried here and
// reverted for request-volume reasons — see AGENTS.md — but was
// deliberately re-added; don't revert it back to IMAX-only without
// re-confirming that tradeoff.)
const NEAR_DAYS_AHEAD = 14;
const DEEP_DAYS_AHEAD = 180;
const PREMIUM_EXPERIENCE_TYPES = new Set(["IMAX", "UltraAVX"]);
const CONCURRENCY = 12;
const THEATRES_PATH_URL = THEATRES_PATH;

// "deep" (default, used when SCRAPE_MODE is unset) runs both the near and
// deep windows, same as this script has always done. "quick" skips the deep
// window entirely -- see writeTheatreFile for how previously-fetched deep
// window days are preserved across quick runs instead of being wiped.
const SCRAPE_MODE = process.env.SCRAPE_MODE === "quick" ? "quick" : "deep";

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

// "Today" has to be Toronto's calendar date, not the scraper host's (GitHub
// Actions runners are UTC, which is 4-5hrs ahead of ET). Using UTC's date
// directly would make any run between ~8pm ET and midnight ET treat the
// still-in-progress evening as "yesterday" and skip it entirely from the
// near window -- it's what was dropping tonight's remaining showtimes from
// runs in that slot.
function torontoTodayStr() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
  }).format(new Date());
}

function dateStrsFrom(startOffset, count) {
  // Anchor to midnight UTC of Toronto's current calendar date, then do the
  // +N-day arithmetic in UTC so it can't itself get shifted by a timezone.
  const today = new Date(`${torontoTodayStr()}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() + startOffset + i);
    return formatDate(date);
  });
}

// Cineplex's API occasionally hangs instead of erroring for a bad
// location/date combo. Without a timeout, a single hung request permanently
// occupies one of the limited concurrency slots (see CONCURRENCY), and
// enough of those can stall the whole scrape. A timeout just becomes a
// normal per-date/per-session failure, handled by the existing fail-soft
// try/catch around each call site.
const REQUEST_TIMEOUT_MS = 15_000;

function timeoutSignal() {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

async function fetchShowtimesForDate(theatreId, dateStr) {
  const url = `${API_BASE}/showtimes?language=en&locationId=${theatreId}&date=${dateStr}`;
  const res = await fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY },
    signal: timeoutSignal(),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${dateStr}`);
  }
  const text = await res.text();
  if (!text) return null; // no data published for this date yet
  return JSON.parse(text);
}

function hasPremiumFormat(experienceTypes) {
  return experienceTypes.some((t) => PREMIUM_EXPERIENCE_TYPES.has(t));
}

function extractMovies(theatreEntry, { premiumOnly }) {
  const dateEntry = theatreEntry?.dates?.[0];
  if (!dateEntry) return [];

  const movies = [];
  for (const movie of dateEntry.movies ?? []) {
    const sessions = [];
    for (const experience of movie.experiences ?? []) {
      const experienceTypes = experience.experienceTypes ?? [];
      if (premiumOnly && !hasPremiumFormat(experienceTypes)) continue;
      for (const session of experience.sessions ?? []) {
        if (session.isInThePast) continue;
        const time = session.showStartDateTime?.slice(11, 16); // HH:MM
        if (!time) continue;
        sessions.push({
          time,
          formats: experienceTypes,
          ticketUrl: session.deeplinkUrl || session.ticketingUrl || null,
          vistaSessionId: session.vistaSessionId ?? null,
          areaCode: session.areaCode ?? null,
          seatDataEligible: Boolean(
            session.isReservedSeating &&
              session.isShowtimeEnabledOnline &&
              !session.isSoldOut &&
              session.vistaSessionId &&
              session.areaCode
          ),
        });
      }
    }
    if (sessions.length === 0) continue;
    sessions.sort((a, b) => a.time.localeCompare(b.time));
    movies.push({
      title: movie.name,
      poster: movie.mediumPosterImageUrl || movie.smallPosterImageUrl || null,
      runtimeMinutes: movie.runtimeInMinutes ?? null,
      sessions,
    });
  }
  return movies;
}

// D-BOX seats live in a completely separate `dboxSeats` section of the
// seat-layout response, not inside `standardSeats`, and aren't flagged via
// the seat's own `type` field (that's still "Standard") -- D-BOX-ness is
// purely which section a seat belongs to. `dboxSeats.left`/`areaWidth` are
// in the same column-index units as `totalColumns`/standardSeats' `column`
// field (verified against real layouts), so a D-BOX seat's position in the
// shared column grid is `left + localColumn * (areaWidth / columnCount)` --
// an approximation, since D-BOX seats are visually wider than one grid
// slot, but consistent with how this seat map already compresses a real
// auditorium into a compact character grid.
//
// Returns `standardSeats.rows` with any matching `dboxSeats` row merged in,
// each D-BOX seat tagged `isDbox: true` and given a `column` in the shared
// coordinate space. `dboxSeats.rows[].number` is a *local* 0-based index
// within just the D-BOX block (0, 1, 2…), not the global standardSeats row
// number -- the row's real global position is `dboxSeats.top + <its index
// in the dboxSeats.rows array>` (verified against real layouts: a 2-row
// D-BOX block with `top: 18` matches global standardSeats rows 18 and 19
// even though the D-BOX rows themselves report `number: 0` and `number: 1`).
function buildMergedRows(layout) {
  const dbox = layout.dboxSeats;
  const columnWidth = dbox?.columnCount ? dbox.areaWidth / dbox.columnCount : 0;
  const dboxRowsByNumber = new Map(
    (dbox?.rows ?? []).map((r, i) => [dbox.top + i, r])
  );

  return (layout.standardSeats?.rows ?? []).map((row) => {
    const seats = row.seats.map((s) => ({ ...s, isDbox: false }));
    const dboxRow = dboxRowsByNumber.get(row.number);
    if (dboxRow) {
      for (const seat of dboxRow.seats) {
        seats.push({
          ...seat,
          column: Math.round(dbox.left + seat.column * columnWidth),
          isDbox: true,
        });
      }
    }
    return { ...row, seats };
  });
}

// Compacts a seat-availability map ({ "section_row_col": "Available" | "Occupied" })
// into one string per row (one char per column, "." where no seat exists at
// that column) using the row/column layout from a seat-layout response.
// `seat.column` is 0-based, matching `col` here.
function compactSeats(layout, seatAvailabilities) {
  const rows = [];
  for (const row of buildMergedRows(layout)) {
    let line = "";
    for (let col = 0; col < layout.totalColumns; col++) {
      const seat = row.seats.find((s) => s.column === col);
      if (!seat) {
        line += ".";
        continue;
      }
      const status = seatAvailabilities[seat.id];
      line += status === "Available" ? "A" : status === "Occupied" ? "O" : "?";
    }
    rows.push(line);
  }
  return rows;
}

function seatTypeChar(seat) {
  if (seat.type === "Wheelchair") return "W";
  if (seat.type === "Companion") return "C";
  if (seat.isDbox) return "D";
  return "S";
}

function compactLayout(layout) {
  const mergedRows = buildMergedRows(layout);
  return {
    totalRows: layout.totalRows,
    totalColumns: layout.totalColumns,
    rowLabels: mergedRows.map((r) => r.label),
    seatTypes: mergedRows.map((row) => {
      let line = "";
      for (let col = 0; col < layout.totalColumns; col++) {
        const seat = row.seats.find((s) => s.column === col);
        line += seat ? seatTypeChar(seat) : ".";
      }
      return line;
    }),
  };
}

async function fetchSeatLayout(theatreId, showtimeId) {
  const url = `https://apis.cineplex.com/prod/ticketing/api/v1/theatre/${theatreId}/showtime/${showtimeId}/seat-layout`;
  const res = await fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for seat-layout ${showtimeId}`);
  return res.json();
}

async function fetchSeatAvailability(theatreId, showtimeId) {
  const url = `https://apis.cineplex.com/prod/ticketing/api/v1/theatre/${theatreId}/showtime/${showtimeId}/seat-availability`;
  const res = await fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY },
    signal: timeoutSignal(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for seat-availability ${showtimeId}`);
  return res.json();
}

// Mutates `days` in place: attaches a compact `seats` grid to each eligible
// session and populates `auditoriums` (keyed by vistaSessionId, layout
// fetched once per showtime and reused across sessions). Failures are
// per-session and never abort the run — a session just keeps its
// time/formats/ticketUrl without seat data.
//
// Cineplex's `areaCode` is NOT a stable per-auditorium id — it's routinely
// reused across completely unrelated showtimes (e.g. IMAX, ScreenX, and
// Regular sessions at the same theatre can all report areaCode
// "0000000001" despite being different rooms). Both the seat-layout and
// seat-availability endpoints are keyed purely by vistaSessionId, so that's
// the only key that's actually correct to cache/dedupe on.
async function attachSeatData(theatreId, days) {
  const auditoriums = {};
  const layoutPromises = new Map(); // vistaSessionId -> Promise<raw layout>

  const eligibleSessions = [];
  for (const day of days) {
    for (const movie of day.movies) {
      for (const session of movie.sessions) {
        if (session.seatDataEligible) eligibleSessions.push(session);
      }
    }
  }

  async function getLayout(vistaSessionId) {
    if (!layoutPromises.has(vistaSessionId)) {
      layoutPromises.set(vistaSessionId, fetchSeatLayout(theatreId, vistaSessionId));
    }
    return layoutPromises.get(vistaSessionId);
  }

  await mapWithConcurrency(eligibleSessions, CONCURRENCY, async (session) => {
    try {
      const [layout, availability] = await Promise.all([
        getLayout(session.vistaSessionId),
        fetchSeatAvailability(theatreId, session.vistaSessionId),
      ]);
      const layoutKey = String(session.vistaSessionId);
      if (!auditoriums[layoutKey]) {
        auditoriums[layoutKey] = compactLayout(layout);
      }
      session.seats = compactSeats(layout, availability.seatAvailabilities ?? {});
      session.layoutKey = layoutKey;
    } catch (err) {
      console.warn(
        `Skipping seat data for session ${session.vistaSessionId}: ${err.message}`
      );
    }
  });

  for (const day of days) {
    for (const movie of day.movies) {
      for (const session of movie.sessions) {
        delete session.seatDataEligible;
        delete session.vistaSessionId;
        delete session.areaCode;
      }
    }
  }

  return auditoriums;
}

async function processDate(theatreId, dateStr, { premiumOnly }) {
  try {
    const payload = await fetchShowtimesForDate(theatreId, dateStr);
    if (!payload) return { dateStr, ok: true, movies: [] };
    const theatreEntry = Array.isArray(payload) ? payload[0] : payload;
    const movies = extractMovies(theatreEntry, { premiumOnly });
    return { dateStr, ok: true, movies };
  } catch (err) {
    console.warn(`Skipping ${theatreId} ${dateStr}: ${err.message}`);
    return { dateStr, ok: false, movies: [] };
  }
}

async function mapWithConcurrency(items, limit, fn, { label } = {}) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  const logEvery = Math.max(1, Math.floor(items.length / 10));
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
      done++;
      if (label && (done % logEvery === 0 || done === items.length)) {
        console.log(`${label}: ${done}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// Runs Phase A (near window, all formats) for every theatre, then Phase B
// (deep window, premium formats only) for theatres whose near window
// revealed a premium-format screen. All (theatre, date) jobs across every
// theatre share one concurrency pool instead of processing theatres
// sequentially.
async function scrapeAllTheatres(theatres) {
  const nearDates = dateStrsFrom(0, NEAR_DAYS_AHEAD);

  const nearJobs = theatres.flatMap((theatre) =>
    nearDates.map((dateStr) => ({ theatre, dateStr, premiumOnly: false }))
  );
  console.log(`Near window: ${nearJobs.length} requests across ${theatres.length} theatres`);
  const nearResults = await mapWithConcurrency(
    nearJobs,
    CONCURRENCY,
    (job) =>
      processDate(job.theatre.id, job.dateStr, { premiumOnly: job.premiumOnly }).then(
        (result) => ({ theatre: job.theatre, ...result })
      ),
    { label: "Near window" }
  );

  const byTheatre = new Map(theatres.map((t) => [t.id, { theatre: t, results: [] }]));
  for (const r of nearResults) byTheatre.get(r.theatre.id).results.push(r);

  if (SCRAPE_MODE === "quick") {
    console.log("Quick mode: skipping deep window");
    return { byTheatre, nearDates };
  }

  const deepDates = dateStrsFrom(NEAR_DAYS_AHEAD, DEEP_DAYS_AHEAD - NEAR_DAYS_AHEAD);
  const deepJobs = [];
  for (const { theatre, results } of byTheatre.values()) {
    const isPremiumCapable = results.some((r) =>
      r.movies.some((m) => m.sessions.some((s) => hasPremiumFormat(s.formats)))
    );
    if (!isPremiumCapable) continue;
    for (const dateStr of deepDates) {
      deepJobs.push({ theatre, dateStr, premiumOnly: true });
    }
  }

  const premiumTheatreCount = new Set(deepJobs.map((j) => j.theatre.id)).size;
  console.log(
    `Deep window: ${deepJobs.length} requests across ${premiumTheatreCount} premium-capable theatres`
  );
  const deepResults = await mapWithConcurrency(
    deepJobs,
    CONCURRENCY,
    (job) =>
      processDate(job.theatre.id, job.dateStr, { premiumOnly: job.premiumOnly }).then(
        (result) => ({ theatre: job.theatre, ...result })
      ),
    { label: "Deep window" }
  );
  for (const r of deepResults) byTheatre.get(r.theatre.id).results.push(r);

  return { byTheatre, nearDates };
}

// In quick mode we never re-fetch the deep window, so without this a quick
// run would overwrite each theatre's file and silently wipe out the
// far-future IMAX advance-sale days the last deep run wrote. Reads the
// theatre's existing file (if any) and returns its `days`/`auditoriums`
// entries dated beyond the near window just fetched, so they can be merged
// back in. Those dates naturally roll into the near window (and get
// refreshed normally) as they approach.
async function loadStaleDeepWindowData(theatre, nearDates, { readFile }) {
  const lastNearDate = nearDates[nearDates.length - 1];
  try {
    const outputPath = new URL(`../${theatre.file}`, import.meta.url);
    const existing = JSON.parse(await readFile(outputPath, "utf8"));
    const staleDays = (existing.days ?? []).filter((d) => d.date > lastNearDate);
    const layoutKeys = new Set(
      staleDays.flatMap((d) =>
        d.movies.flatMap((m) => m.sessions.flatMap((s) => (s.layoutKey ? [s.layoutKey] : [])))
      )
    );
    const auditoriums = {};
    for (const key of layoutKeys) {
      if (existing.auditoriums?.[key]) auditoriums[key] = existing.auditoriums[key];
    }
    return { days: staleDays, auditoriums };
  } catch {
    return { days: [], auditoriums: {} };
  }
}

// Returns true if this theatre's file was written, false if it was skipped
// (every date request failed, so we leave the existing file untouched).
async function writeTheatreFile(theatre, results, nearDates, { readFile, mkdir, writeFile }) {
  const successCount = results.filter((r) => r.ok).length;
  if (successCount === 0) {
    console.error(
      `Every date request failed for ${theatre.name}; leaving existing data untouched.`
    );
    return false;
  }

  const freshDays = results
    .filter((r) => r.movies.length > 0)
    .sort((a, b) => a.dateStr.localeCompare(b.dateStr))
    .map((r) => ({ date: r.dateStr, movies: r.movies }));

  let days = freshDays;
  let staleAuditoriums = {};
  if (SCRAPE_MODE === "quick") {
    const stale = await loadStaleDeepWindowData(theatre, nearDates, { readFile });
    staleAuditoriums = stale.auditoriums;
    days = [...freshDays, ...stale.days].sort((a, b) => a.date.localeCompare(b.date));
  }

  const auditoriums = {
    ...staleAuditoriums,
    ...(await attachSeatData(theatre.id, freshDays)),
  };

  const output = {
    updatedAt: new Date().toISOString(),
    theatre: { id: theatre.id, name: theatre.name },
    auditoriums,
    days,
  };

  const outputPath = new URL(`../${theatre.file}`, import.meta.url);
  await mkdir(new URL("../data", import.meta.url), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n");

  console.log(`Wrote ${days.length} day(s) of showtimes to ${theatre.file}`);
  return true;
}

// Theatres with seat-eligible sessions each fetch their own seat data
// (attachSeatData) independently, so writing them one at a time leaves the
// rest of the concurrency budget idle for most of the run. Run a handful of
// theatres' write phases concurrently instead — each still uses CONCURRENCY
// internally for its own seat-layout/availability requests.
const WRITE_CONCURRENCY = 6;

async function main() {
  const { readFile, mkdir, writeFile } = await import("node:fs/promises");
  const theatres = JSON.parse(await readFile(THEATRES_PATH_URL, "utf8"));

  const { byTheatre, nearDates } = await scrapeAllTheatres(theatres);

  const writeResults = await mapWithConcurrency(
    [...byTheatre.values()],
    WRITE_CONCURRENCY,
    ({ theatre, results }) =>
      writeTheatreFile(theatre, results, nearDates, { readFile, mkdir, writeFile }),
    { label: "Writing theatre files" }
  );
  const anySucceeded = writeResults.some(Boolean);

  if (!anySucceeded) {
    console.error("Every theatre failed entirely; nothing was written.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
