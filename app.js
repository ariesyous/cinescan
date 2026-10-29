const calendarEl = document.getElementById("calendar");
const updatedEl = document.getElementById("updated");
const theatreNameEl = document.getElementById("theatre-name");
const theatreSearchEl = document.getElementById("theatre-search");
const theatreSearchClearEl = document.getElementById("theatre-search-clear");
const theatreDropdownEl = document.getElementById("theatre-dropdown");
const formatFilterEl = document.getElementById("format-filter");
const dateBarEl = document.getElementById("date-bar");
const regionButtonsEl = document.getElementById("region-buttons");
const breadcrumbEl = document.getElementById("breadcrumb");
const areaButtonsEl = document.getElementById("area-buttons");
const theatreListEl = document.getElementById("theatre-list");

const DEFAULT_THEATRE_ID = 7402; // Scotiabank Theatre Toronto

// The theatre a visitor last picked, reopened when they next arrive at the
// home page. A per-browser convenience, so storage failures are ignored.
const THEATRE_KEY = "cinescan:theatre";

function readStoredTheatre() {
  try {
    const stored = JSON.parse(localStorage.getItem(THEATRE_KEY));
    return stored && typeof stored.slug === "string" && typeof stored.name === "string"
      ? stored
      : null;
  } catch {
    return null;
  }
}

function storeTheatre(theatre) {
  try {
    localStorage.setItem(THEATRE_KEY, JSON.stringify({ slug: theatre.slug, name: theatre.name }));
  } catch {
    // Private mode or blocked storage: the page still works, just forgets.
  }
}

// Deployed pages (built by scripts/build-site.mjs) have a static page per
// theatre at theatres/<slug>/ and a <base> pointing at the site root, so
// theatre URLs use those paths. index.html served straight from a checkout
// has no such pages and uses ?theatre=<slug> instead.
const PATH_ROUTING =
  document.querySelector('meta[name="cinescan-routing"]')?.content === "path";
const HOME_TITLE = document.title;

const REGIONS = [
  { key: "GTA", label: "GTA" },
  { key: "Montreal", label: "Montreal" },
  { key: "Vancouver", label: "Vancouver" },
  { key: "other", label: "Everywhere Else" },
];

const PROVINCE_NAMES = {
  AB: "Alberta",
  BC: "British Columbia",
  MB: "Manitoba",
  NB: "New Brunswick",
  NL: "Newfoundland and Labrador",
  NS: "Nova Scotia",
  ON: "Ontario",
  PE: "Prince Edward Island",
  QC: "Quebec",
  SK: "Saskatchewan",
};

// Which day it is at a theatre depends on where the theatre is, not where
// the visitor is. Everything but Saskatchewan observes daylight saving.
const PROVINCE_TIME_ZONES = {
  AB: "America/Edmonton",
  BC: "America/Vancouver",
  MB: "America/Winnipeg",
  NB: "America/Moncton",
  NL: "America/St_Johns",
  NS: "America/Halifax",
  ON: "America/Toronto",
  PE: "America/Halifax",
  QC: "America/Toronto",
  SK: "America/Regina",
};

// "YYYY-MM-DD" for today at the theatre, matching the dates the scraper writes.
function todayAt(theatre) {
  const timeZone = PROVINCE_TIME_ZONES[theatre.province] || "America/Toronto";
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

let auditoriums = {};
let updatedAtLabel = "";
let currentDays = [];
let currentToday = "";
// Formats the visitor picked; empty means every format (same as movie.js).
let selectedTags = new Set();

let allTheatres = [];
let currentRegion = null; // "GTA" | "Montreal" | "Vancouver" | "other" | null
let currentArea = null; // city name, or province code when currentRegion === "other"
let currentTheatreId = null;
let pendingUrlFormats = null; // format tags to seed the next renderFormatFilter() from

const seatPopover = document.createElement("div");
seatPopover.className = "seat-popover";
seatPopover.hidden = true;
document.body.appendChild(seatPopover);

const supportsHover = window.matchMedia("(hover: hover)").matches;
let activeSeatChip = null;

function hideSeatPopover() {
  seatPopover.hidden = true;
  activeSeatChip = null;
}

function renderSeatPopover(session, chipEl, movie) {
  const layout = auditoriums[session.layoutKey];
  if (!layout || !session.seats) return;

  seatPopover.innerHTML = "";

  const endLabel = endTimeLabel(session.time, movie.runtimeMinutes);
  if (endLabel) {
    // Showtime plus runtime: previews and ads run before the film, so the
    // real finish is later than this.
    const when = document.createElement("p");
    when.className = "seat-when";
    when.innerHTML = `<strong>Ends about ${endLabel}</strong> <span>${formatRuntime(movie.runtimeMinutes)} film, previews extra</span>`;
    seatPopover.appendChild(when);
  }

  const grid = document.createElement("div");
  grid.className = "seat-grid";
  grid.style.gridTemplateColumns = `repeat(${layout.totalColumns}, 1fr)`;
  session.seats.forEach((rowStr, rowIndex) => {
    const typeStr = layout.seatTypes?.[rowIndex] ?? "";
    for (let col = 0; col < rowStr.length; col++) {
      const ch = rowStr[col];
      const typeCh = typeStr[col] ?? "S";
      const cell = document.createElement("span");
      cell.className =
        "seat " +
        (ch === "A"
          ? typeCh === "W" || typeCh === "C"
            ? "seat-available-accessible"
            : typeCh === "D"
            ? "seat-available-dbox"
            : "seat-available"
          : ch === "O"
          ? "seat-occupied"
          : "seat-none");
      grid.appendChild(cell);
    }
  });
  seatPopover.appendChild(grid);

  const hasDbox = (layout.seatTypes ?? []).some((row) => row.includes("D"));
  const legend = document.createElement("div");
  legend.className = "seat-legend";
  legend.innerHTML = `
    <span><span class="seat-swatch seat-available"></span> Available</span>
    <span><span class="seat-swatch seat-available-accessible"></span> Accessible</span>
    ${hasDbox ? '<span><span class="seat-swatch seat-available-dbox"></span> D-BOX</span>' : ""}
    <span><span class="seat-swatch seat-occupied"></span> Occupied</span>
  `;
  seatPopover.appendChild(legend);

  if (updatedAtLabel) {
    const caption = document.createElement("p");
    caption.className = "seat-caption";
    caption.textContent = `Seats as of ${updatedAtLabel}`;
    seatPopover.appendChild(caption);
  }

  // On touch the first tap opens this preview instead of the ticket page
  // (see renderMovie), which isn't obvious until someone's tapped twice.
  if (!supportsHover && session.ticketUrl) {
    const hint = document.createElement("p");
    hint.className = "seat-hint";
    hint.textContent = "Tap the time again to open tickets ↗";
    seatPopover.appendChild(hint);
  }

  seatPopover.hidden = false;

  const chipRect = chipEl.getBoundingClientRect();
  const popRect = seatPopover.getBoundingClientRect();
  let left = chipRect.left + window.scrollX;
  let top = chipRect.bottom + window.scrollY + 6;
  if (left + popRect.width > window.scrollX + document.documentElement.clientWidth - 8) {
    left = window.scrollX + document.documentElement.clientWidth - popRect.width - 8;
  }
  if (left < window.scrollX + 8) left = window.scrollX + 8;
  seatPopover.style.left = `${left}px`;
  seatPopover.style.top = `${top}px`;
}

document.addEventListener("click", (e) => {
  if (!seatPopover.hidden && !seatPopover.contains(e.target) && !e.target.closest(".session")) {
    hideSeatPopover();
  }
  if (!theatreDropdownEl.hidden && !e.target.closest(".theatre-picker")) {
    setDropdownOpen(false);
  }
});

function formatTimeLabel(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

// "2h 5m", for a runtime in minutes. Also in scripts/build-site.mjs, which
// shows it on movie pages and can't share code with this file.
function formatRuntime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

// When a session ends if the film starts at its listed time, e.g. "12:45 AM"
// ("" when the runtime isn't known). It can land after midnight.
function endTimeLabel(timeStr, runtimeMinutes) {
  if (!runtimeMinutes) return "";
  const [h, m] = timeStr.split(":").map(Number);
  const end = (h * 60 + m + runtimeMinutes) % (24 * 60);
  return formatTimeLabel(`${Math.floor(end / 60)}:${String(end % 60).padStart(2, "0")}`);
}

function formatDayLabel(dateStr) {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

// Same as movieSlug in scripts/build-site.mjs, which generates the
// movies/<slug>/ pages these titles link to; keep the two identical.
function movieSlug(title) {
  return (
    title
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "movie"
  );
}

// Turns a raw Cineplex format tag ("Laser Projection", "VIP 18+") into a
// CSS-safe class suffix ("laser-projection", "vip-18").
function tagSlug(tag) {
  return tag
    .toLowerCase()
    .replace(/\+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderFormatBadges(formats) {
  const wrap = document.createElement("span");
  wrap.className = "format-badges";
  for (const tag of formats) {
    const badge = document.createElement("span");
    badge.className = `format-badge tag-${tagSlug(tag)}`;
    badge.textContent = tag;
    wrap.appendChild(badge);
  }
  return wrap;
}

function sessionVisible(session) {
  return selectedTags.size === 0 || session.formats.some((t) => selectedTags.has(t));
}

function renderMovie(movie, visibleSessions) {
  const el = document.createElement("div");
  el.className = "movie";

  const img = document.createElement("img");
  img.src = movie.poster || "";
  img.alt = "";
  img.loading = "lazy";
  el.appendChild(img);

  const info = document.createElement("div");
  info.className = "movie-info";

  const title = document.createElement("p");
  title.className = "movie-title";
  // Movie pages only exist in the deployed build (see PATH_ROUTING).
  if (PATH_ROUTING) {
    const link = document.createElement("a");
    link.href = `movies/${movieSlug(movie.title)}/`;
    link.title = "Every theatre showing this movie";
    link.textContent = movie.title;
    title.appendChild(link);
  } else {
    title.textContent = movie.title;
  }
  info.appendChild(title);

  const sessions = document.createElement("div");
  sessions.className = "sessions";
  for (const session of visibleSessions) {
    const chipWrap = document.createElement("div");
    chipWrap.className = "session-wrap";

    const chip = session.ticketUrl
      ? document.createElement("a")
      : document.createElement("span");
    chip.className = "session";
    chip.textContent = formatTimeLabel(session.time);
    if (session.ticketUrl) {
      chip.href = session.ticketUrl;
      chip.target = "_blank";
      chip.rel = "noopener";
    }
    if (session.seats && auditoriums[session.layoutKey]) {
      chip.classList.add("has-seats");
      if (supportsHover) {
        chip.addEventListener("mouseenter", () => renderSeatPopover(session, chip, movie));
        chip.addEventListener("mouseleave", hideSeatPopover);
        chip.addEventListener("focus", () => renderSeatPopover(session, chip, movie));
        chip.addEventListener("blur", hideSeatPopover);
      } else {
        // Touch: first tap previews the seat map, a second tap on the same
        // chip follows the ticket link. mouseenter isn't used here since
        // touch browsers fire a synthetic one right before "click", which
        // would otherwise make the popover look "already open" and let the
        // very first tap fall through to the ticket page.
        chip.addEventListener("click", (e) => {
          if (activeSeatChip !== chip) {
            e.preventDefault();
            renderSeatPopover(session, chip, movie);
            activeSeatChip = chip;
          } else {
            activeSeatChip = null;
          }
        });
      }
    }
    chipWrap.appendChild(chip);
    chipWrap.appendChild(renderFormatBadges(session.formats));
    sessions.appendChild(chipWrap);
  }
  info.appendChild(sessions);

  el.appendChild(info);
  return el;
}

function renderDay(day, visibleMovies) {
  const card = document.createElement("section");
  card.className = "day-card";
  card.id = dayId(day.date);
  card.dataset.date = day.date;

  const heading = document.createElement("h2");
  heading.textContent = formatDayLabel(day.date);
  card.appendChild(heading);

  for (const { movie, sessions } of visibleMovies) {
    card.appendChild(renderMovie(movie, sessions));
  }

  return card;
}

function renderCalendar() {
  calendarEl.innerHTML = "";

  if (!currentDays || currentDays.length === 0) {
    calendarEl.innerHTML = '<p class="empty">No showtimes found right now.</p>';
    renderDateBar([]);
    return;
  }

  const renderedDates = [];
  for (const day of currentDays) {
    const visibleMovies = [];
    for (const movie of day.movies) {
      const sessions = movie.sessions.filter(sessionVisible);
      if (sessions.length > 0) visibleMovies.push({ movie, sessions });
    }
    if (visibleMovies.length === 0) continue;
    calendarEl.appendChild(renderDay(day, visibleMovies));
    renderedDates.push(day.date);
  }

  if (renderedDates.length === 0) {
    calendarEl.innerHTML = '<p class="empty">No showtimes match the selected formats.</p>';
  }
  renderDateBar(renderedDates);
}

// The date bar is a sticky strip with a chip for each day on show, so a
// visitor can jump to a day instead of scrolling past every day before it.
// It follows the page as it scrolls: chips for the days on screen are marked
// and the first of them is active. It only lists days that have showtimes
// under the current format filter, which also shows when a format plays.
const MIN_DAYS_FOR_DATE_BAR = 3;
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let activeDate = null;
let dateBarLocked = false; // while a chip's own scroll runs, so it isn't overridden midway
let dateBarLockTimer = 0;
let dateBarFrame = 0;

function dayId(date) {
  return `day-${date}`;
}

function renderDateBar(dates) {
  const show = dates.length >= MIN_DAYS_FOR_DATE_BAR;
  dateBarEl.hidden = !show;
  document.documentElement.classList.toggle("has-date-bar", show);
  dateBarEl.innerHTML = "";
  activeDate = null;
  if (!show) return;

  const track = document.createElement("div");
  track.className = "date-bar-track";
  let month = "";
  for (const date of dates) {
    const day = new Date(date + "T00:00:00");
    if (date.slice(0, 7) !== month) {
      month = date.slice(0, 7);
      const label = document.createElement("span");
      label.className = "date-bar-month";
      label.textContent = day.toLocaleDateString(undefined, { month: "short" });
      track.appendChild(label);
    }

    const isToday = date === currentToday;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "date-chip";
    chip.dataset.date = date;
    chip.classList.toggle("is-today", isToday);
    chip.classList.toggle("is-past", date < currentToday);
    chip.setAttribute(
      "aria-label",
      day.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        (isToday ? ", today" : "")
    );

    const weekday = document.createElement("span");
    weekday.className = "date-chip-weekday";
    weekday.textContent = isToday ? "Today" : day.toLocaleDateString(undefined, { weekday: "short" });
    const num = document.createElement("span");
    num.className = "date-chip-day";
    num.textContent = day.getDate();
    chip.append(weekday, num);

    chip.addEventListener("click", () => jumpToDate(date));
    track.appendChild(chip);
  }
  dateBarEl.appendChild(track);
  updateDateBar();
}

function jumpToDate(date) {
  const card = document.getElementById(dayId(date));
  if (!card) return;
  setActiveDate(date);
  dateBarLocked = true;
  clearTimeout(dateBarLockTimer);
  dateBarLockTimer = setTimeout(unlockDateBar, 600);
  card.scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });

  // Carry keyboard and screen reader focus along, and flash the card: on a
  // wide screen it's one of several in the row that scrolls into place.
  card.tabIndex = -1;
  card.focus({ preventScroll: true });
  card.classList.remove("flash");
  void card.offsetWidth; // so the animation restarts if it was still running
  card.classList.add("flash");
  card.addEventListener("animationend", () => card.classList.remove("flash"), { once: true });
}

function unlockDateBar() {
  dateBarLocked = false;
  updateDateBar({ keepActive: true });
}

function setActiveDate(date) {
  if (date === activeDate) return;
  activeDate = date;
  for (const chip of dateBarEl.querySelectorAll(".date-chip")) {
    const on = chip.dataset.date === date;
    chip.classList.toggle("active", on);
    if (on) {
      chip.setAttribute("aria-current", "date");
      keepChipInView(chip);
    } else {
      chip.removeAttribute("aria-current");
    }
  }
}

// Scrolls the bar sideways to centre a chip that's near, or past, its edge.
function keepChipInView(chip) {
  const track = chip.parentElement;
  const t = track.getBoundingClientRect();
  const c = chip.getBoundingClientRect();
  const margin = c.width * 1.5;
  if (c.left < t.left + margin || c.right > t.right - margin) {
    track.scrollBy({
      left: c.left - t.left - (t.width - c.width) / 2,
      behavior: reduceMotion.matches ? "auto" : "smooth",
    });
  }
}

// Marks the chips for the days on screen and, unless a chip was just used,
// makes the first of them the active one.
function updateDateBar({ keepActive = false } = {}) {
  if (dateBarEl.hidden) return;
  const barBottom = dateBarEl.getBoundingClientRect().bottom;
  const cards = [...calendarEl.querySelectorAll(".day-card")];
  const onScreen = new Set();
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (rect.bottom > barBottom + 4 && rect.top < window.innerHeight) onScreen.add(card.dataset.date);
  }
  // Nothing on screen means the calendar is entirely below the fold or scrolled past.
  const first =
    [...onScreen][0] ??
    (cards[0].getBoundingClientRect().top >= window.innerHeight ? cards[0] : cards.at(-1)).dataset.date;

  for (const chip of dateBarEl.querySelectorAll(".date-chip")) {
    chip.classList.toggle("in-view", onScreen.has(chip.dataset.date));
  }
  if (!keepActive) setActiveDate(first);
}

function onPageScroll() {
  if (dateBarLocked) {
    clearTimeout(dateBarLockTimer);
    dateBarLockTimer = setTimeout(unlockDateBar, 150);
    return;
  }
  if (dateBarFrame) return;
  dateBarFrame = requestAnimationFrame(() => {
    dateBarFrame = 0;
    updateDateBar();
  });
}
window.addEventListener("scroll", onPageScroll, { passive: true });
window.addEventListener("resize", onPageScroll);

function renderFormatFilter() {
  const tags = new Set();
  for (const day of currentDays) {
    for (const movie of day.movies) {
      for (const session of movie.sessions) {
        for (const tag of session.formats) tags.add(tag);
      }
    }
  }

  const sortedTags = [...tags].sort();
  // Like the movie pages: picking formats shows just those, and picking none
  // (or all of them) shows everything.
  selectedTags = new Set(
    pendingUrlFormats ? sortedTags.filter((t) => pendingUrlFormats.includes(t)) : []
  );
  if (selectedTags.size === sortedTags.length) selectedTags.clear();
  pendingUrlFormats = null;

  formatFilterEl.innerHTML = "";
  if (sortedTags.length <= 1) return;

  const chips = [];

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = "format-clear-btn";
  allBtn.textContent = "All formats";
  formatFilterEl.appendChild(allBtn);

  function updateFilterButtons() {
    allBtn.classList.toggle("active", selectedTags.size === 0);
    allBtn.setAttribute("aria-pressed", String(selectedTags.size === 0));
    for (const chip of chips) {
      const on = selectedTags.has(chip.dataset.tag);
      chip.classList.toggle("active", on);
      chip.setAttribute("aria-pressed", String(on));
    }
  }

  // The "formats" URL param only exists while the filter is narrowed, so
  // the default view keeps a clean URL.
  function syncFormatsToUrl() {
    const url = new URL(location.href);
    if (selectedTags.size === 0) {
      url.searchParams.delete("formats");
    } else {
      url.searchParams.set("formats", [...selectedTags].join(","));
    }
    history.replaceState(history.state, "", url);
  }

  function applyFilter() {
    updateFilterButtons();
    syncFormatsToUrl();
    renderCalendar();
  }

  allBtn.addEventListener("click", () => {
    selectedTags.clear();
    applyFilter();
  });

  for (const tag of sortedTags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.tag = tag;
    chip.className = `format-chip tag-${tagSlug(tag)}`;
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      if (selectedTags.has(tag)) selectedTags.delete(tag);
      else selectedTags.add(tag);
      if (selectedTags.size === sortedTags.length) selectedTags.clear();
      applyFilter();
    });
    chips.push(chip);
    formatFilterEl.appendChild(chip);
  }

  updateFilterButtons();
}

// Which region a theatre belongs to, and its "area" label within that
// region (a city for the three named metros, a province for everything
// else).
function regionForTheatre(theatre) {
  return theatre.metro || "other";
}
function areaForTheatre(theatre) {
  return regionForTheatre(theatre) === "other" ? theatre.province : theatre.city;
}
function areaLabel(region, areaKey) {
  return region === "other" ? PROVINCE_NAMES[areaKey] || areaKey : areaKey;
}

function renderRegionButtons() {
  regionButtonsEl.innerHTML = "";
  for (const region of REGIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "region-button";
    btn.textContent = region.label;
    btn.addEventListener("click", () => {
      currentRegion = region.key;
      currentArea = null;
      renderNav();
    });
    regionButtonsEl.appendChild(btn);
  }
}

function renderBreadcrumb() {
  breadcrumbEl.innerHTML = "";
  breadcrumbEl.hidden = !currentRegion;
  if (!currentRegion) return;

  const rootLink = document.createElement("button");
  rootLink.type = "button";
  rootLink.className = "breadcrumb-link";
  rootLink.textContent = "All Regions";
  rootLink.addEventListener("click", () => {
    currentRegion = null;
    currentArea = null;
    renderNav();
  });
  breadcrumbEl.appendChild(rootLink);

  breadcrumbEl.appendChild(document.createTextNode(" › "));

  const regionDef = REGIONS.find((r) => r.key === currentRegion);
  if (currentArea) {
    const regionLink = document.createElement("button");
    regionLink.type = "button";
    regionLink.className = "breadcrumb-link";
    regionLink.textContent = regionDef.label;
    regionLink.addEventListener("click", () => {
      currentArea = null;
      renderNav();
    });
    breadcrumbEl.appendChild(regionLink);

    breadcrumbEl.appendChild(document.createTextNode(" › "));

    const areaSpan = document.createElement("span");
    areaSpan.className = "breadcrumb-current";
    areaSpan.textContent = areaLabel(currentRegion, currentArea);
    breadcrumbEl.appendChild(areaSpan);
  } else {
    const regionSpan = document.createElement("span");
    regionSpan.className = "breadcrumb-current";
    regionSpan.textContent = regionDef.label;
    breadcrumbEl.appendChild(regionSpan);
  }
}

function renderAreaButtons() {
  areaButtonsEl.innerHTML = "";
  if (!currentRegion || currentArea) return;

  const areas = new Map(); // areaKey -> theatre[]
  for (const t of allTheatres) {
    if (regionForTheatre(t) !== currentRegion) continue;
    const key = areaForTheatre(t);
    if (!key) continue;
    if (!areas.has(key)) areas.set(key, []);
    areas.get(key).push(t);
  }

  const sortedKeys = [...areas.keys()].sort((a, b) =>
    areaLabel(currentRegion, a).localeCompare(areaLabel(currentRegion, b))
  );

  for (const key of sortedKeys) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "area-button";
    btn.textContent = areaLabel(currentRegion, key);
    btn.addEventListener("click", () => {
      currentArea = key;
      renderNav();
    });
    areaButtonsEl.appendChild(btn);
  }
}

function renderTheatreList(theatres) {
  theatreListEl.innerHTML = "";
  if (!currentRegion || !currentArea) return;

  const inArea = allTheatres
    .filter((t) => regionForTheatre(t) === currentRegion && areaForTheatre(t) === currentArea)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const theatre of inArea) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theatre-list-item";
    if (theatre.id === currentTheatreId) btn.classList.add("active");
    btn.textContent = theatre.name;
    btn.addEventListener("click", () => selectTheatre(theatre, theatres, { remember: true }));
    theatreListEl.appendChild(btn);
  }
}

function renderNav(theatres = allTheatres) {
  if (currentRegion) {
    regionButtonsEl.hidden = true;
  } else {
    regionButtonsEl.hidden = false;
    if (!regionButtonsEl.childElementCount) renderRegionButtons();
  }
  renderBreadcrumb();
  renderAreaButtons();
  renderTheatreList(theatres);
}

// Loads a theatre's showtimes and keeps the region/breadcrumb/theatre-list
// nav, the search box, and the URL in sync with the selection, regardless
// of which of the two pickers (or the initial page load) triggered it.
// `push: false` is used for loads that shouldn't add a new history entry
// (initial load from the URL, and responding to popstate itself). `formats`
// (an array of tag strings) seeds the format filter -- e.g. from a shared
// link -- instead of the default "everything selected"; omitting it resets
// the filter to everything, which is what picking a theatre normally does.
// `drill: false` loads the theatre's showtimes without auto-drilling the
// nav into its region/area, leaving the top-level region buttons showing --
// used for the no-slug landing page, which also keeps its own URL and title
// so the home page doesn't present itself as the default theatre's page.
// `remember: true` (the pickers' own choices, not loads from a URL) saves the
// theatre to open next time the visitor arrives at the home page.
function selectTheatre(
  theatre,
  theatres,
  { push = true, formats = null, drill = true, remember = false } = {}
) {
  if (remember) storeTheatre(theatre);
  currentTheatreId = theatre.id;
  currentRegion = drill ? regionForTheatre(theatre) : null;
  currentArea = drill ? areaForTheatre(theatre) : null;
  theatreSearchEl.value = theatre.name;
  updateSearchClearVisibility();
  renderNav(theatres);
  pendingUrlFormats = formats;
  loadTheatre(theatre, theatres);

  if (!drill) {
    document.title = HOME_TITLE;
    return;
  }
  document.title = `${theatre.name} Showtimes | CineScan`;

  const url = theatreUrl(theatre.slug);
  if (formats) {
    url.searchParams.set("formats", formats.join(","));
  } else {
    url.searchParams.delete("formats");
  }
  if (push) {
    history.pushState({ theatreSlug: theatre.slug }, "", url);
  } else {
    history.replaceState({ theatreSlug: theatre.slug }, "", url);
  }
}

// Strips accents so "Montreal" matches "Montréal", "Quebec" matches
// "Québec", etc.
function normalize(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// The dropdown works as a combobox: focus stays in the search box while the
// arrow keys move a highlight through the options (aria-activedescendant),
// and Enter picks the highlighted one. Typing highlights the first match, so
// type-and-Enter goes straight to the top result.
let activeOption = -1;

function dropdownOptions() {
  return [...theatreDropdownEl.querySelectorAll(".theatre-option")];
}

function setDropdownOpen(open) {
  theatreDropdownEl.hidden = !open;
  theatreSearchEl.setAttribute("aria-expanded", String(open));
  if (!open) setActiveOption(-1);
}

function setActiveOption(index, { scroll = false } = {}) {
  activeOption = index;
  const options = dropdownOptions();
  options.forEach((option, i) => {
    option.classList.toggle("active", i === index);
    option.setAttribute("aria-selected", String(i === index));
  });
  const option = options[index];
  if (!option) {
    theatreSearchEl.removeAttribute("aria-activedescendant");
    return;
  }
  theatreSearchEl.setAttribute("aria-activedescendant", option.id);
  if (scroll) {
    // Scroll the list rather than the page, keeping the province heading
    // in view above the first option of each group.
    const heading = option.previousElementSibling?.matches(".theatre-group-heading")
      ? option.previousElementSibling
      : option;
    const bottom = option.offsetTop + option.offsetHeight;
    if (heading.offsetTop < theatreDropdownEl.scrollTop) {
      theatreDropdownEl.scrollTop = heading.offsetTop;
    } else if (bottom > theatreDropdownEl.scrollTop + theatreDropdownEl.clientHeight) {
      theatreDropdownEl.scrollTop = bottom - theatreDropdownEl.clientHeight;
    }
  }
}

function renderTheatreDropdown(theatres, query) {
  theatreDropdownEl.innerHTML = "";
  const q = normalize(query.trim());
  const matches = q
    ? theatres.filter(
        (t) => normalize(t.name).includes(q) || normalize(t.city || "").includes(q)
      )
    : theatres;

  if (matches.length === 0) {
    const empty = document.createElement("p");
    empty.className = "theatre-dropdown-empty";
    empty.setAttribute("role", "option"); // a listbox may only hold options and groups
    empty.setAttribute("aria-disabled", "true");
    empty.textContent = "No theatres match.";
    theatreDropdownEl.appendChild(empty);
    setActiveOption(-1);
    return;
  }

  const byProvince = new Map();
  for (const t of matches) {
    const key = t.province || "Other";
    if (!byProvince.has(key)) byProvince.set(key, []);
    byProvince.get(key).push(t);
  }

  const provinces = [...byProvince.keys()].sort((a, b) => {
    const nameA = PROVINCE_NAMES[a] || a;
    const nameB = PROVINCE_NAMES[b] || b;
    return nameA.localeCompare(nameB);
  });

  let optionCount = 0;
  for (const province of provinces) {
    const group = document.createElement("div");
    group.className = "theatre-group";
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", `theatre-group-${province}`);

    const heading = document.createElement("p");
    heading.className = "theatre-group-heading";
    heading.id = `theatre-group-${province}`;
    heading.textContent = PROVINCE_NAMES[province] || province;
    group.appendChild(heading);

    for (const theatre of byProvince.get(province).sort((a, b) => a.name.localeCompare(b.name))) {
      const index = optionCount++;
      const item = document.createElement("button");
      item.type = "button";
      item.id = `theatre-option-${theatre.id}`;
      item.className = "theatre-option";
      item.setAttribute("role", "option");
      item.tabIndex = -1;
      item.textContent = theatre.city ? `${theatre.name} — ${theatre.city}` : theatre.name;
      item.addEventListener("mouseenter", () => setActiveOption(index));
      item.addEventListener("click", () => {
        setDropdownOpen(false);
        selectTheatre(theatre, theatres, { remember: true });
      });
      group.appendChild(item);
    }
    theatreDropdownEl.appendChild(group);
  }
  setActiveOption(q ? 0 : -1);
}

function updateSearchClearVisibility() {
  theatreSearchClearEl.hidden = theatreSearchEl.value.length === 0;
}

function setupTheatrePicker(theatres) {
  theatreSearchEl.addEventListener("focus", () => {
    renderTheatreDropdown(theatres, theatreSearchEl.value);
    setDropdownOpen(true);
  });
  theatreSearchEl.addEventListener("input", () => {
    renderTheatreDropdown(theatres, theatreSearchEl.value);
    setDropdownOpen(true);
    updateSearchClearVisibility();
  });
  // relatedTarget is the element about to receive focus, so a click on a
  // dropdown item (a <button>) is correctly recognized as "still inside"
  // and doesn't hide the dropdown out from under the click.
  theatreSearchEl.addEventListener("focusout", (e) => {
    if (!theatreDropdownEl.contains(e.relatedTarget)) {
      setDropdownOpen(false);
    }
  });
  theatreSearchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      setDropdownOpen(false);
      theatreSearchEl.blur();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const wasClosed = theatreDropdownEl.hidden;
      if (wasClosed) {
        renderTheatreDropdown(theatres, theatreSearchEl.value);
        setDropdownOpen(true);
      }
      const count = dropdownOptions().length;
      if (count === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      const from = wasClosed ? -1 : activeOption;
      // No highlight yet: Down starts at the first option, Up at the last.
      const next = from === -1 ? (step === 1 ? 0 : count - 1) : (from + step + count) % count;
      setActiveOption(next, { scroll: true });
    } else if (e.key === "Enter" && !e.isComposing && !theatreDropdownEl.hidden) {
      const option = dropdownOptions()[activeOption];
      if (option) {
        e.preventDefault();
        option.click();
        theatreSearchEl.blur(); // closes the on-screen keyboard
      }
    }
  });

  theatreSearchClearEl.addEventListener("click", () => {
    theatreSearchEl.value = "";
    updateSearchClearVisibility();
    renderTheatreDropdown(theatres, "");
    setDropdownOpen(true);
    theatreSearchEl.focus();
  });
}

async function loadTheatre(theatre, theatres) {
  theatreNameEl.textContent = `Showtimes at ${theatre.name}`;
  calendarEl.innerHTML = '<p class="loading">Loading showtimes&hellip;</p>';
  formatFilterEl.innerHTML = "";
  renderDateBar([]);
  updatedEl.textContent = "";

  try {
    const res = await fetch(theatre.file, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    auditoriums = data.auditoriums || {};
    currentDays = data.days || [];
    currentToday = todayAt(theatre);

    if (data.updatedAt) {
      const formatted = new Date(data.updatedAt).toLocaleString("en-US", {
        timeZone: "America/Toronto",
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short",
      });
      updatedEl.textContent = `Last updated ${formatted}`;
      updatedAtLabel = formatted;
    }

    renderFormatFilter();
    renderCalendar();
  } catch (err) {
    calendarEl.innerHTML = `<p class="error">Couldn't load showtimes: ${err.message}</p>`;
  }
}

function parseFormatsParam(params) {
  const raw = params.get("formats");
  return raw ? raw.split(",") : null;
}

function theatreUrl(slug) {
  const url = new URL(location.href);
  if (PATH_ROUTING) {
    url.pathname = new URL(`theatres/${slug}/`, document.baseURI).pathname;
    url.searchParams.delete("theatre");
  } else {
    url.searchParams.set("theatre", slug);
  }
  return url;
}

function slugFromPath() {
  if (!PATH_ROUTING) return null;
  const rootPath = new URL(document.baseURI).pathname;
  const match =
    location.pathname.startsWith(rootPath) &&
    location.pathname.slice(rootPath.length).match(/^theatres\/([^/]+)\/(?:index\.html)?$/);
  return match ? match[1] : null;
}

// Whether this document was served as a theatre's own page, and so carries
// that theatre's title/description/canonical rather than the home page's.
const STARTED_ON_THEATRE_PAGE = Boolean(slugFromPath());

function showTheatreFromLocation() {
  // The ?theatre= fallback also keeps links shared before path routing
  // working; selectTheatre then rewrites them to the theatre's path.
  const slug = slugFromPath() || new URLSearchParams(location.search).get("theatre");
  const urlTheatre = slug && allTheatres.find((t) => t.slug === slug);
  if (!urlTheatre && STARTED_ON_THEATRE_PAGE) {
    location.reload(); // e.g. Back to the home URL: load the real home page
    return;
  }
  // Without a theatre in the URL, a returning visitor gets the one they last
  // picked, shown like any theatre page (nav drilled in, URL and title to
  // match). Everyone else, crawlers included, gets the default under the
  // home URL.
  const stored = !urlTheatre && readStoredTheatre();
  const remembered = stored && allTheatres.find((t) => t.slug === stored.slug);
  const theatre =
    urlTheatre ||
    remembered ||
    allTheatres.find((t) => t.id === DEFAULT_THEATRE_ID) ||
    allTheatres[0];
  selectTheatre(theatre, allTheatres, {
    push: false,
    formats: parseFormatsParam(new URLSearchParams(location.search)),
    drill: Boolean(urlTheatre || remembered),
  });
}

async function main() {
  // The heading still says the default theatre until the list below loads,
  // which would flash the wrong name at a returning visitor.
  const stored = readStoredTheatre();
  if (stored && !slugFromPath() && !new URLSearchParams(location.search).get("theatre")) {
    theatreNameEl.textContent = `Showtimes at ${stored.name}`;
  }

  try {
    const res = await fetch("data/theatres.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const theatres = await res.json();
    allTheatres = theatres;

    setupTheatrePicker(theatres);

    window.addEventListener("popstate", showTheatreFromLocation);
    showTheatreFromLocation();
  } catch (err) {
    calendarEl.innerHTML = `<p class="error">Couldn't load theatres: ${err.message}</p>`;
  }
}

main();
