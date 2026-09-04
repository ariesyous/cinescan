const calendarEl = document.getElementById("calendar");
const updatedEl = document.getElementById("updated");
const theatreNameEl = document.getElementById("theatre-name");
const theatreSearchEl = document.getElementById("theatre-search");
const theatreSearchClearEl = document.getElementById("theatre-search-clear");
const theatreDropdownEl = document.getElementById("theatre-dropdown");
const formatFilterEl = document.getElementById("format-filter");
const regionButtonsEl = document.getElementById("region-buttons");
const breadcrumbEl = document.getElementById("breadcrumb");
const areaButtonsEl = document.getElementById("area-buttons");
const theatreListEl = document.getElementById("theatre-list");

const DEFAULT_THEATRE_ID = 7402; // Scotiabank Theatre Toronto

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

let auditoriums = {};
let updatedAtLabel = "";
let currentDays = [];
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

function renderSeatPopover(session, chipEl) {
  const layout = auditoriums[session.layoutKey];
  if (!layout || !session.seats) return;

  seatPopover.innerHTML = "";

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
    theatreDropdownEl.hidden = true;
  }
});

function formatTimeLabel(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 || 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function formatDayLabel(dateStr) {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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
  return session.formats.some((t) => selectedTags.has(t));
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
  title.textContent = movie.title;
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
        chip.addEventListener("mouseenter", () => renderSeatPopover(session, chip));
        chip.addEventListener("mouseleave", hideSeatPopover);
        chip.addEventListener("focus", () => renderSeatPopover(session, chip));
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
            renderSeatPopover(session, chip);
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
    return;
  }

  let renderedAny = false;
  for (const day of currentDays) {
    const visibleMovies = [];
    for (const movie of day.movies) {
      const sessions = movie.sessions.filter(sessionVisible);
      if (sessions.length > 0) visibleMovies.push({ movie, sessions });
    }
    if (visibleMovies.length === 0) continue;
    calendarEl.appendChild(renderDay(day, visibleMovies));
    renderedAny = true;
  }

  if (!renderedAny) {
    calendarEl.innerHTML = '<p class="empty">No showtimes match the selected formats.</p>';
  }
}

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
  if (pendingUrlFormats) {
    selectedTags = new Set(sortedTags.filter((t) => pendingUrlFormats.includes(t)));
  } else {
    selectedTags = new Set(sortedTags);
  }
  pendingUrlFormats = null;

  formatFilterEl.innerHTML = "";
  if (sortedTags.length <= 1) return;

  const chips = [];

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "format-clear-btn";
  formatFilterEl.appendChild(clearBtn);

  function updateClearBtnLabel() {
    clearBtn.textContent = selectedTags.size === 0 ? "Select All" : "Clear All";
  }

  function updateChipsFromSelection() {
    for (const chip of chips) {
      chip.classList.toggle("active", selectedTags.has(chip.dataset.tag));
    }
  }

  // A "formats" URL param is only meaningful as a proper subset of what's
  // available -- everything selected is the default, so that's the same
  // as no filter at all and the param is omitted for a cleaner URL.
  function syncFormatsToUrl() {
    const url = new URL(location.href);
    if (selectedTags.size === sortedTags.length) {
      url.searchParams.delete("formats");
    } else {
      url.searchParams.set("formats", [...selectedTags].join(","));
    }
    history.replaceState(history.state, "", url);
  }

  clearBtn.addEventListener("click", () => {
    if (selectedTags.size === 0) {
      selectedTags = new Set(sortedTags);
    } else {
      selectedTags.clear();
    }
    updateChipsFromSelection();
    updateClearBtnLabel();
    syncFormatsToUrl();
    renderCalendar();
  });

  for (const tag of sortedTags) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.dataset.tag = tag;
    chip.className = `format-chip tag-${tagSlug(tag)}`;
    chip.classList.toggle("active", selectedTags.has(tag));
    chip.textContent = tag;
    chip.addEventListener("click", () => {
      if (selectedTags.has(tag)) {
        selectedTags.delete(tag);
        chip.classList.remove("active");
      } else {
        selectedTags.add(tag);
        chip.classList.add("active");
      }
      updateClearBtnLabel();
      syncFormatsToUrl();
      renderCalendar();
    });
    chips.push(chip);
    formatFilterEl.appendChild(chip);
  }

  updateClearBtnLabel();
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
    btn.addEventListener("click", () => selectTheatre(theatre, theatres));
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
// used for the no-slug landing page.
function selectTheatre(theatre, theatres, { push = true, formats = null, drill = true } = {}) {
  currentTheatreId = theatre.id;
  currentRegion = drill ? regionForTheatre(theatre) : null;
  currentArea = drill ? areaForTheatre(theatre) : null;
  theatreSearchEl.value = theatre.name;
  updateSearchClearVisibility();
  renderNav(theatres);
  pendingUrlFormats = formats;
  loadTheatre(theatre, theatres);

  const url = new URL(location.href);
  url.searchParams.set("theatre", theatre.slug);
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
    empty.textContent = "No theatres match.";
    theatreDropdownEl.appendChild(empty);
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

  for (const province of provinces) {
    const group = document.createElement("div");
    group.className = "theatre-group";

    const heading = document.createElement("p");
    heading.className = "theatre-group-heading";
    heading.textContent = PROVINCE_NAMES[province] || province;
    group.appendChild(heading);

    for (const theatre of byProvince.get(province).sort((a, b) => a.name.localeCompare(b.name))) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "theatre-option";
      item.textContent = theatre.city ? `${theatre.name} — ${theatre.city}` : theatre.name;
      item.addEventListener("click", () => {
        theatreDropdownEl.hidden = true;
        selectTheatre(theatre, theatres);
      });
      group.appendChild(item);
    }
    theatreDropdownEl.appendChild(group);
  }
}

function updateSearchClearVisibility() {
  theatreSearchClearEl.hidden = theatreSearchEl.value.length === 0;
}

function setupTheatrePicker(theatres) {
  theatreSearchEl.addEventListener("focus", () => {
    renderTheatreDropdown(theatres, theatreSearchEl.value);
    theatreDropdownEl.hidden = false;
  });
  theatreSearchEl.addEventListener("input", () => {
    renderTheatreDropdown(theatres, theatreSearchEl.value);
    theatreDropdownEl.hidden = false;
    updateSearchClearVisibility();
  });
  // relatedTarget is the element about to receive focus, so a click on a
  // dropdown item (a <button>) is correctly recognized as "still inside"
  // and doesn't hide the dropdown out from under the click.
  theatreSearchEl.addEventListener("focusout", (e) => {
    if (!theatreDropdownEl.contains(e.relatedTarget)) {
      theatreDropdownEl.hidden = true;
    }
  });
  theatreSearchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      theatreDropdownEl.hidden = true;
      theatreSearchEl.blur();
    }
  });

  theatreSearchClearEl.addEventListener("click", () => {
    theatreSearchEl.value = "";
    updateSearchClearVisibility();
    renderTheatreDropdown(theatres, "");
    theatreDropdownEl.hidden = false;
    theatreSearchEl.focus();
  });
}

async function loadTheatre(theatre, theatres) {
  theatreNameEl.textContent = `Showtimes at ${theatre.name}`;
  document.title = `CineScan — ${theatre.name}`;
  calendarEl.innerHTML = '<p class="loading">Loading showtimes&hellip;</p>';
  formatFilterEl.innerHTML = "";
  updatedEl.textContent = "";

  try {
    const res = await fetch(theatre.file, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    auditoriums = data.auditoriums || {};
    currentDays = data.days || [];

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

async function main() {
  try {
    const res = await fetch("data/theatres.json", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const theatres = await res.json();
    allTheatres = theatres;

    setupTheatrePicker(theatres);

    window.addEventListener("popstate", () => {
      const params = new URLSearchParams(location.search);
      const slug = params.get("theatre");
      const theatre = slug && allTheatres.find((t) => t.slug === slug);
      if (theatre) {
        selectTheatre(theatre, allTheatres, { push: false, formats: parseFormatsParam(params) });
      }
    });

    const urlParams = new URLSearchParams(location.search);
    const urlSlug = urlParams.get("theatre");
    const urlTheatre = urlSlug && theatres.find((t) => t.slug === urlSlug);
    const defaultTheatre =
      urlTheatre || theatres.find((t) => t.id === DEFAULT_THEATRE_ID) || theatres[0];
    selectTheatre(defaultTheatre, theatres, {
      push: false,
      formats: urlTheatre ? parseFormatsParam(urlParams) : null,
      drill: Boolean(urlTheatre),
    });
  } catch (err) {
    calendarEl.innerHTML = `<p class="error">Couldn't load theatres: ${err.message}</p>`;
  }
}

main();
