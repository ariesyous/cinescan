// Builds the deployable site into an output directory (default `_site/`)
// for .github/workflows/pages.yml. The checkout itself stays a working,
// build-free site served as-is; this only adds what search engines need on
// top of it:
//
// - A static page per theatre at theatres/<slug>/ with its own title,
//   description, canonical URL, structured data and dated session times.
//   Each is the same app as index.html (app.js swaps in the full
//   calendar on load), so these are real entry points, not doorway pages.
// - A static page per movie at movies/<slug>/ listing every theatre showing
//   it, with each format combination's dates, plus a movies/ index. These
//   don't load app.js; movie.js adds format filters (and, on movie pages,
//   reopens the visitor's province) on top.
// - A crawlable directory of every theatre in each page's footer, since the
//   region picker is built from buttons rather than links.
// - sitemap.xml listing every page and a root robots.txt advertising it.
//
// Every generated page carries <meta name="cinescan-routing" content="path">,
// which tells app.js to use theatres/<slug>/ URLs instead of ?theatre=<slug>
// and to link movie titles to their movies/<slug>/ pages.
//
// Run from the repo root after `data-snapshot.mjs restore`. A theatre whose
// data file is missing still gets a page, with an explicit unavailable message.
//
//   node scripts/build-site.mjs [out-dir]

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_URL = "https://cinescan.app/";
const COPY = ["app.js", "movie.js", "style.css", "assets", "data"];

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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Escapes "<" so a value can't close the surrounding <script> element.
function jsonLd(value) {
  const json = JSON.stringify(value, null, 2).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

// Fails the build (and therefore the deploy, leaving the previous one live)
// if index.html no longer contains what this script expects to rewrite.
function replaceOnce(html, pattern, replacement, label) {
  let matched = false;
  const out = html.replace(pattern, (...args) => {
    matched = true;
    return replacement(...args);
  });
  if (!matched) {
    throw new Error(`index.html: couldn't find ${label}; update build-site.mjs to match`);
  }
  return out;
}

function extract(html, pattern, label) {
  const match = html.match(pattern);
  if (!match) throw new Error(`index.html: couldn't find ${label}; update build-site.mjs to match`);
  return match[0];
}

function setMeta(html, key, value) {
  const pattern = new RegExp(`(<meta\\s+(?:name|property)="${key}"\\s+content=")[^"]*(")`);
  return replaceOnce(html, pattern, (_, start, end) => start + escapeHtml(value) + end, `meta ${key}`);
}

function setPageMeta(html, { title, description, url }) {
  html = replaceOnce(html, /<title>[^<]*<\/title>/, () => `<title>${escapeHtml(title)}</title>`, "<title>");
  html = replaceOnce(
    html,
    /<link rel="canonical" href="[^"]*" \/>/,
    () => `<link rel="canonical" href="${escapeHtml(url)}" />`,
    "canonical link"
  );
  html = setMeta(html, "description", description);
  html = setMeta(html, "og:url", url);
  html = setMeta(html, "og:title", title);
  html = setMeta(html, "og:description", description);
  html = setMeta(html, "twitter:title", title);
  html = setMeta(html, "twitter:description", description);
  return html;
}

function injectSiteHead(html, baseHref, structuredData) {
  return replaceOnce(
    html,
    /<!--SITE_HEAD-->/,
    () =>
      [
        `<base href="${baseHref}" />`,
        `<meta name="cinescan-routing" content="path" />`,
        jsonLd(structuredData),
      ].join("\n  "),
    "<!--SITE_HEAD--> placeholder"
  );
}

// A page that shares index.html's <head> (analytics, styles, social tags),
// brand line and footer, but has its own body instead of the theatre app.
function staticPage(template, { title, description, url, baseHref, structuredData, heading, intro, main }) {
  const brand = extract(template, /<p class="brand">[\s\S]*?<\/p>/, "brand line");
  const footer = extract(template, /<footer class="site-footer">[\s\S]*?<\/footer>/, "site footer");
  let html = setPageMeta(template, { title, description, url });
  html = injectSiteHead(html, baseHref, structuredData);
  return replaceOnce(
    html,
    /<body>[\s\S]*<\/body>/,
    () =>
      [
        `<body>`,
        `  <header>`,
        `    ${brand}`,
        `    <h1>${heading}</h1>`,
        intro,
        `  </header>`,
        ``,
        `  ${main}`,
        ``,
        `  ${footer}`,
        ``,
        `  <script src="movie.js"></script>`,
        `</body>`,
      ].join("\n"),
    "<body>"
  );
}

// ["a", "b", "c"] -> "a, b and c"
function listJoin(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function provinceName(code) {
  return PROVINCE_NAMES[code] || code || "Other";
}

function theatrePath(theatre) {
  return `theatres/${theatre.slug}/`;
}

// Same as movieSlug in app.js, which links calendar titles to these pages;
// keep the two identical. Titles that slug the same share one page.
function movieSlug(title) {
  return (
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "movie"
  );
}

function moviePath(slug) {
  return `movies/${slug}/`;
}

// Same as tagSlug in app.js, for the shared .tag-* badge colours.
function tagSlug(tag) {
  return tag
    .toLowerCase()
    .replace(/\+/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function renderBadges(formats) {
  const badges = formats.map(
    (tag) => `<span class="format-badge tag-${tagSlug(tag)}">${escapeHtml(tag)}</span>`
  );
  return `<span class="format-badges">${badges.join("")}</span>`;
}

// "YYYY-MM-DD" for today in Toronto, matching the dates the scraper writes.
function todayInToronto() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

function formatDate(dateStr, { weekday = true } = {}) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-CA", {
    timeZone: "UTC",
    ...(weekday ? { weekday: "short" } : {}),
    month: "short",
    day: "numeric",
  });
}

function formatDateRange(dates) {
  const first = dates[0];
  const last = dates.at(-1);
  if (first === last) return `${formatDate(first)} only`;
  const range = `${formatDate(first, { weekday: false })} – ${formatDate(last, { weekday: false })}`;
  return `${range} · ${dates.length} days`;
}

function formatRuntime(minutes) {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

// Tags sorted by how often they occur, most common first.
function byFrequency(counts) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

function bump(counts, key, by = 1) {
  counts.set(key, (counts.get(key) || 0) + by);
}

// One entry per movie still showing today or later, with every format it
// plays in and the first date it does.
function summarizeMovies(data, today) {
  const movies = new Map();
  const formatCounts = new Map();
  for (const day of data?.days ?? []) {
    if (day.date < today) continue;
    for (const movie of day.movies) {
      let entry = movies.get(movie.title);
      if (!entry) {
        entry = { title: movie.title, firstDate: day.date, formats: new Set() };
        movies.set(movie.title, entry);
      }
      if (day.date < entry.firstDate) entry.firstDate = day.date;
      for (const session of movie.sessions) {
        for (const tag of session.formats) {
          entry.formats.add(tag);
          bump(formatCounts, tag);
        }
      }
    }
  }
  const sorted = [...movies.values()].sort(
    (a, b) => a.firstDate.localeCompare(b.firstDate) || a.title.localeCompare(b.title)
  );
  return { movies: sorted, formats: byFrequency(formatCounts) };
}

// Every movie showing today or later across all theatres, keyed by slug:
// which theatres show it, and on which dates in each format combination.
function collectMovies(theatres, dataBySlug, today) {
  const movies = new Map();
  for (const theatre of theatres) {
    const data = dataBySlug.get(theatre.slug);
    for (const day of data?.days ?? []) {
      if (day.date < today) continue;
      for (const movie of day.movies) {
        const slug = movieSlug(movie.title);
        let entry = movies.get(slug);
        if (!entry) {
          entry = {
            slug,
            titleCounts: new Map(),
            poster: "",
            runtimeMinutes: 0,
            dates: new Set(),
            updatedAt: "",
            theatres: new Map(),
            formatTheatres: new Map(), // tag -> Set of theatre slugs
          };
          movies.set(slug, entry);
        }
        bump(entry.titleCounts, movie.title);
        entry.poster ||= movie.poster || "";
        entry.runtimeMinutes ||= movie.runtimeMinutes || 0;
        entry.dates.add(day.date);
        if (data.updatedAt > entry.updatedAt) entry.updatedAt = data.updatedAt;

        let showing = entry.theatres.get(theatre.slug);
        if (!showing) {
          showing = { theatre, combos: new Map() };
          entry.theatres.set(theatre.slug, showing);
        }
        for (const session of movie.sessions) {
          const formats = [...session.formats].sort();
          const key = formats.join("|");
          if (!showing.combos.has(key)) showing.combos.set(key, { formats, dates: new Set() });
          showing.combos.get(key).dates.add(day.date);
          for (const tag of formats) {
            if (!entry.formatTheatres.has(tag)) entry.formatTheatres.set(tag, new Set());
            entry.formatTheatres.get(tag).add(theatre.slug);
          }
        }
      }
    }
  }
  for (const entry of movies.values()) {
    entry.title = byFrequency(entry.titleCounts)[0];
    entry.sortedDates = [...entry.dates].sort();
    const formatCounts = new Map(
      [...entry.formatTheatres].map(([tag, slugs]) => [tag, slugs.size])
    );
    entry.formats = byFrequency(formatCounts);
    entry.formatCounts = formatCounts;
  }
  return movies;
}

// Same AM/PM labels as app.js; the stored clock time is local to the theatre.
function formatTimeLabel(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function snapshotLabel(data) {
  if (!data) return "Showtime snapshot unavailable.";
  if (!data.updatedAt || !Number.isFinite(Date.parse(data.updatedAt))) return "Snapshot update time unavailable.";
  const label = new Date(data.updatedAt).toLocaleString("en-US", {
    timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
  return `Snapshot last updated ${label}`;
}

function renderShowtimes(data, today) {
  const days = (data?.days ?? []).filter((day) => day.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const cards = days.map((day) => {
    const movies = day.movies.filter((movie) => movie.sessions.length).map((movie) => {
      const sessions = [...movie.sessions].sort((a, b) => a.time.localeCompare(b.time)).map((session) => {
        const time = `<time datetime="${escapeHtml(day.date)}T${escapeHtml(session.time)}">${formatTimeLabel(session.time)}</time>`;
        const chip = session.ticketUrl
          ? `<a class="session" href="${escapeHtml(session.ticketUrl)}" target="_blank" rel="noopener">${time}</a>`
          : `<span class="session">${time}</span>`;
        return `<div class="session-wrap">${chip}${renderBadges(session.formats)}</div>`;
      });
      const poster = movie.poster ? `<img src="${escapeHtml(movie.poster)}" alt="" loading="lazy" />` : "";
      return `<div class="movie">${poster}<div class="movie-info"><h3 class="movie-title"><a href="${moviePath(movieSlug(movie.title))}">${escapeHtml(movie.title)}</a></h3><div class="sessions">${sessions.join("")}</div></div></div>`;
    });
    if (!movies.length) return "";
    return `<section class="day-card" data-date="${escapeHtml(day.date)}"><h2><time datetime="${escapeHtml(day.date)}">${escapeHtml(formatDate(day.date))}, ${day.date.slice(0, 4)}</time></h2>\n${movies.join("\n")}\n</section>`;
  }).filter(Boolean);
  return cards.length ? cards.join("\n") : `<p class="empty">${data ? "No current or upcoming showtimes are listed in this snapshot." : "No showtime snapshot is available for this theatre."} This does not mean the theatre is closed. <a href="movies/">Browse movies</a> or choose another theatre below.</p>`;
}

function groupByProvince(items, provinceOf) {
  const groups = new Map();
  for (const item of items) {
    const key = provinceOf(item) || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.entries()].sort((a, b) => provinceName(a[0]).localeCompare(provinceName(b[0])));
}

function renderDirectory(theatres) {
  const groups = groupByProvince(theatres, (t) => t.province).map(([province, list]) => {
    const links = list
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => {
        const city = t.city ? ` <span class="theatre-directory-city">${escapeHtml(t.city)}</span>` : "";
        return `          <li><a href="${theatrePath(t)}">${escapeHtml(t.name)}</a>${city}</li>`;
      });
    return [
      `      <section>`,
      `        <h2>${escapeHtml(provinceName(province))}</h2>`,
      `        <ul>`,
      ...links,
      `        </ul>`,
      `      </section>`,
    ].join("\n");
  });

  return [
    `<details class="theatre-directory">`,
    `      <summary>All ${theatres.length} Cineplex theatres in Canada</summary>`,
    `      <div class="theatre-directory-groups">`,
    ...groups,
    `      </div>`,
    `    </details>`,
  ].join("\n");
}

function theatrePage(template, theatre, data, today) {
  const url = SITE_URL + theatrePath(theatre);
  const place = [theatre.city, provinceName(theatre.province)].filter(Boolean).join(", ");
  const { movies, formats } = summarizeMovies(data, today);
  const premium = formats.filter((tag) => tag !== "Regular").slice(0, 4);

  const title = `${theatre.name} Showtimes | CineScan`;
  let description = `Showtimes at ${theatre.name} in ${place}`;
  if (movies.length > 0) {
    description += ` — ${movies.length} ${movies.length === 1 ? "movie" : "movies"}`;
    if (premium.length > 0) description += `, including ${listJoin(premium)} screenings`;
  }
  description += ". Filter by format and preview seat availability.";

  let html = setPageMeta(template, { title, description, url });
  html = injectSiteHead(html, "../../", {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: title,
    url,
    description,
    ...(data?.updatedAt ? { dateModified: data.updatedAt } : {}),
    isPartOf: { "@type": "WebSite", name: "CineScan", url: SITE_URL },
    about: {
      "@type": "MovieTheater",
      name: theatre.name,
      address: {
        "@type": "PostalAddress",
        ...(theatre.city ? { addressLocality: theatre.city } : {}),
        ...(theatre.province ? { addressRegion: theatre.province } : {}),
        addressCountry: "CA",
      },
    },
  });
  html = replaceOnce(
    html,
    /<h1 id="theatre-name">[^<]*<\/h1>/,
    () => `<h1 id="theatre-name">Showtimes at ${escapeHtml(theatre.name)}</h1>`,
    "theatre-name heading"
  );
  html = replaceOnce(html, /<p id="updated" class="updated"><\/p>/,
    () => `<p id="updated" class="updated">${escapeHtml(snapshotLabel(data))}</p>`, "updated paragraph");
  html = replaceOnce(
    html,
    /<main id="calendar" class="calendar">[\s\S]*?<\/main>/,
    () => `<main id="calendar" class="calendar" data-snapshot-theatre="${theatre.slug}">\n${renderShowtimes(data, today)}\n  </main>`,
    "calendar <main>"
  );
  return html;
}

// Format chips for movie.js, hidden until it wires them up. `counts` maps
// each tag to the number shown on its chip.
function renderFormatFilter(formats, counts) {
  const chips = formats.map(
    (tag) =>
      `      <button type="button" class="format-chip tag-${tagSlug(tag)}" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)} <span class="chip-count">${counts.get(tag)}</span></button>`
  );
  return [
    `    <div id="movie-filter" class="format-filter movie-filter" hidden>`,
    `      <button type="button" class="format-clear-btn">All formats</button>`,
    ...chips,
    `    </div>`,
    `    <p id="movie-count" class="updated"></p>`,
  ].join("\n");
}

// Provinces showing a movie are collapsed, biggest first (by theatres
// showing it), so a wide release isn't one long scroll; movie.js reopens
// the province a visitor last opened. Small releases start expanded.
const OPEN_ALL_MAX_THEATRES = 6;

function moviePage(template, movie) {
  const url = SITE_URL + moviePath(movie.slug);
  const theatreCount = movie.theatres.size;
  const premium = movie.formats.filter((tag) => tag !== "Regular").slice(0, 4);
  const title = `${movie.title} — Cineplex Showtimes in Canada | CineScan`;
  let description = `Where to watch ${movie.title} at Cineplex: ${theatreCount} ${theatreCount === 1 ? "theatre" : "theatres"} across Canada`;
  if (premium.length > 0) description += `, including ${listJoin(premium)}`;
  description += ". Compare formats and dates by theatre.";

  const facts = [
    `Playing at ${theatreCount} ${theatreCount === 1 ? "theatre" : "theatres"}`,
    formatRuntime(movie.runtimeMinutes),
    formatDateRange(movie.sortedDates).replace(/ · \d+ days$/, ""),
  ].filter(Boolean);
  const poster = movie.poster
    ? `    <img class="movie-hero-poster" src="${escapeHtml(movie.poster)}" alt="${escapeHtml(movie.title)} poster" />\n`
    : "";
  const intro = [
    `    <div class="movie-hero">`,
    poster + `      <p class="movie-hero-facts">${facts.map(escapeHtml).join(" · ")}</p>`,
    `    </div>`,
    renderFormatFilter(movie.formats, movie.formatCounts),
  ].join("\n");

  const showings = [...movie.theatres.values()];
  const groups = groupByProvince(showings, (s) => s.theatre.province).sort(
    (a, b) => b[1].length - a[1].length
  );
  const open = groups.length === 1 || theatreCount <= OPEN_ALL_MAX_THEATRES ? " open" : "";
  const provinces = groups.map(([province, list]) => {
    const rows = list
      .sort(
        (a, b) =>
          (a.theatre.city || "").localeCompare(b.theatre.city || "") ||
          a.theatre.name.localeCompare(b.theatre.name)
      )
      .map(({ theatre, combos }) => {
        const comboRows = [...combos.values()]
          .map((combo) => ({ ...combo, sortedDates: [...combo.dates].sort() }))
          .sort(
            (a, b) =>
              a.sortedDates[0].localeCompare(b.sortedDates[0]) ||
              a.formats.join().localeCompare(b.formats.join())
          )
          .map(
            (combo) =>
              `            <li data-formats="${escapeHtml(combo.formats.join("|"))}">${renderBadges(combo.formats)} <span class="movie-dates">${escapeHtml(formatDateRange(combo.sortedDates))}</span></li>`
          );
        const city = theatre.city ? ` <span class="movie-theatre-city">${escapeHtml(theatre.city)}</span>` : "";
        return [
          `        <li class="movie-theatre">`,
          `          <p class="movie-theatre-name"><a href="${theatrePath(theatre)}" data-theatre-link>${escapeHtml(theatre.name)}</a>${city}</p>`,
          `          <ul class="movie-combos">`,
          ...comboRows,
          `          </ul>`,
          `        </li>`,
        ].join("\n");
      });
    const count = `${list.length} ${list.length === 1 ? "theatre" : "theatres"}`;
    return [
      `    <details class="movie-province" data-province="${escapeHtml(province)}"${open}>`,
      `      <summary><h2>${escapeHtml(provinceName(province))}</h2> <span class="movie-province-count">${count}</span></summary>`,
      `      <ul class="movie-theatres">`,
      ...rows,
      `      </ul>`,
      `    </details>`,
    ].join("\n");
  });

  return staticPage(template, {
    title,
    description,
    url,
    baseHref: "../../",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "Movie",
      name: movie.title,
      url,
      ...(movie.poster ? { image: movie.poster } : {}),
      ...(movie.runtimeMinutes ? { duration: `PT${movie.runtimeMinutes}M` } : {}),
    },
    heading: `${escapeHtml(movie.title)} <span class="heading-sub">at Cineplex theatres in Canada</span>`,
    intro,
    main: [`<main class="movie-page">`, ...provinces, `  </main>`].join("\n"),
  });
}

// data-formats/data-counts let movie.js filter cards by format and show how
// many theatres play the movie in each selected one.
function renderMovieCard(movie, today) {
  const count = movie.theatres.size;
  const opens = movie.sortedDates[0] > today ? `Opens ${formatDate(movie.sortedDates[0])}` : "";
  const meta = [opens, `${count} ${count === 1 ? "theatre" : "theatres"}`].filter(Boolean);
  // The top four premium formats show; movie.js reveals the rest when
  // they're filtered for, so a card always shows why it matched.
  const badges = movie.formats
    .filter((tag) => tag !== "Regular")
    .map(
      (tag, i) =>
        `<span class="format-badge tag-${tagSlug(tag)}" data-tag="${escapeHtml(tag)}"${i >= 4 ? " data-extra hidden" : ""}>${escapeHtml(tag)}</span>`
    );
  const poster = movie.poster
    ? `<img src="${escapeHtml(movie.poster)}" alt="" loading="lazy" />`
    : `<span class="movie-card-noposter"></span>`;
  const counts = JSON.stringify(Object.fromEntries(movie.formatCounts));
  return [
    `      <li data-formats="${escapeHtml(movie.formats.join("|"))}" data-counts="${escapeHtml(counts)}" data-opens="${escapeHtml(opens)}">` +
      `<a class="movie-card" href="${moviePath(movie.slug)}">`,
    `        ${poster}`,
    `        <span class="movie-card-title">${escapeHtml(movie.title)}</span>`,
    `        <span class="movie-card-meta">${escapeHtml(meta.join(" · "))}</span>`,
    badges.length ? `        <span class="format-badges">${badges.join("")}</span>` : "",
    `      </a></li>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function moviesIndexPage(template, movies, today) {
  const url = SITE_URL + "movies/";
  const all = [...movies.values()];
  const nowPlaying = all
    .filter((m) => m.sortedDates[0] <= today)
    .sort((a, b) => b.theatres.size - a.theatres.size || a.title.localeCompare(b.title));
  const comingSoon = all
    .filter((m) => m.sortedDates[0] > today)
    .sort(
      (a, b) =>
        a.sortedDates[0].localeCompare(b.sortedDates[0]) ||
        b.theatres.size - a.theatres.size ||
        a.title.localeCompare(b.title)
    );

  const movieCounts = new Map(); // tag -> number of movies playing in it
  for (const movie of all) for (const tag of movie.formats) bump(movieCounts, tag);

  const title = "Movies Playing at Cineplex in Canada | CineScan";
  const description =
    `${nowPlaying.length} movies now playing and ${comingSoon.length} coming soon at Cineplex theatres across Canada. ` +
    "See which theatres show each one in IMAX, UltraAVX, ScreenX, 4DX and more.";

  const section = (heading, list) =>
    list.length === 0
      ? ""
      : [
          `    <section class="movie-index-section">`,
          `      <h2>${heading}</h2>`,
          `      <ul class="movie-grid">`,
          ...list.map((m) => renderMovieCard(m, today)),
          `      </ul>`,
          `    </section>`,
        ].join("\n");

  return staticPage(template, {
    title,
    description,
    url,
    baseHref: "../",
    structuredData: {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "Movies playing at Cineplex in Canada",
      url,
      itemListElement: [...nowPlaying, ...comingSoon].map((m, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: SITE_URL + moviePath(m.slug),
      })),
    },
    heading: "Movies at Cineplex theatres in Canada",
    intro: [
      `    <p class="refresh-note">Pick a movie to see every theatre showing it, by format and date.</p>`,
      renderFormatFilter(byFrequency(movieCounts), movieCounts),
    ].join("\n"),
    main: [
      `<main class="movie-index">`,
      section("Now playing", nowPlaying),
      section("Coming soon", comingSoon),
      `  </main>`,
    ]
      .filter(Boolean)
      .join("\n"),
  });
}

// GitHub Pages serves this for any missing path, e.g. a movie whose run
// ended since someone shared or bookmarked its page. It can be served at
// any depth, so its <base> is the site's absolute path.
function notFoundPage(template) {
  return staticPage(template, {
    title: "Page not found | CineScan",
    description: "This page doesn't exist, or the movie has finished its run.",
    url: SITE_URL + "404.html",
    baseHref: new URL(SITE_URL).pathname,
    structuredData: { "@context": "https://schema.org", "@type": "WebPage", name: "Page not found" },
    heading: "Page not found",
    intro: `    <p class="refresh-note">This page doesn't exist, or the movie has finished its run.</p>`,
    main: [
      `<main class="movie-page not-found">`,
      `    <p><a href="movies/">Browse movies now playing</a> or <a href="./">pick a theatre</a>.</p>`,
      `  </main>`,
    ].join("\n"),
  });
}

function homePage(template) {
  return injectSiteHead(template, "./", {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "CineScan",
    url: SITE_URL,
    description: template.match(/<meta\s+name="description"\s+content="([^"]*)"/)?.[1],
  });
}

function sitemap(entries) {
  const urls = entries.map(({ url, lastmod }) => {
    const mod = lastmod ? `<lastmod>${escapeHtml(lastmod)}</lastmod>` : "";
    return `  <url><loc>${escapeHtml(url)}</loc>${mod}</url>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    ...urls,
    `</urlset>`,
    ``,
  ].join("\n");
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw new Error(`${file}: ${err.message}`);
  }
}

async function writePage(outDir, pagePath, html) {
  const dir = path.join(outDir, pagePath);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "index.html"), html);
}

async function main() {
  const outDir = path.resolve(process.argv[2] || "_site");
  const rel = path.relative(process.cwd(), outDir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to build into ${outDir}: it must be inside the current directory`);
  }

  const template = await readFile("index.html", "utf8");
  const theatres = JSON.parse(await readFile("data/theatres.json", "utf8"));
  const today = todayInToronto();

  for (const t of theatres) {
    if (!/^[a-z0-9-]+$/.test(t.slug)) throw new Error(`Unexpected theatre slug: ${t.slug}`);
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const entry of COPY) {
    await cp(entry, path.join(outDir, entry), { recursive: true });
  }

  const dataBySlug = new Map();
  for (const theatre of theatres) {
    const data = await readJson(theatre.file);
    if (data) dataBySlug.set(theatre.slug, data);
  }
  const movies = collectMovies(theatres, dataBySlug, today);

  let shared = replaceOnce(
    template,
    /<!--THEATRE_DIRECTORY-->/,
    () => renderDirectory(theatres),
    "<!--THEATRE_DIRECTORY--> placeholder"
  );
  shared = replaceOnce(
    shared,
    /<!--SITE_NAV-->/,
    () => `<span class="brand-nav"> &middot; <a href="movies/">Browse movies</a></span>`,
    "<!--SITE_NAV--> placeholder"
  );

  const theatreEntries = [];
  for (const theatre of theatres) {
    const data = dataBySlug.get(theatre.slug);
    await writePage(outDir, theatrePath(theatre), theatrePage(shared, theatre, data, today));
    theatreEntries.push({ url: SITE_URL + theatrePath(theatre), lastmod: data?.updatedAt });
  }

  const movieEntries = [];
  for (const movie of movies.values()) {
    await writePage(outDir, moviePath(movie.slug), moviePage(shared, movie));
    movieEntries.push({ url: SITE_URL + moviePath(movie.slug), lastmod: movie.updatedAt });
  }
  await writePage(outDir, "movies/", moviesIndexPage(shared, movies, today));

  const latest = theatreEntries.map((e) => e.lastmod).filter(Boolean).sort().at(-1);
  await writeFile(path.join(outDir, "index.html"), homePage(shared));
  await writeFile(path.join(outDir, "404.html"), notFoundPage(shared));
  await writeFile(
    path.join(outDir, "sitemap.xml"),
    sitemap([
      { url: SITE_URL, lastmod: latest },
      { url: SITE_URL + "movies/", lastmod: latest },
      ...movieEntries,
      ...theatreEntries,
    ])
  );

  await writeFile(
    path.join(outDir, "robots.txt"),
    `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}sitemap.xml\n`
  );

  const missing = theatres.length - dataBySlug.size;
  console.log(
    `Built ${theatres.length} theatre pages and ${movies.size} movie pages into ${rel}` +
      (missing ? ` (${missing} theatres without data files)` : "")
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

