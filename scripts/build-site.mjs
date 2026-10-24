// Builds the deployable site into an output directory (default `_site/`)
// for .github/workflows/pages.yml. The checkout itself stays a working,
// build-free site served as-is; this only adds what search engines need on
// top of it:
//
// - A static page per theatre at theatres/<slug>/ with its own title,
//   description, canonical URL, structured data and a crawlable now-playing
//   list. Each is the same app as index.html (app.js swaps in the full
//   calendar on load), so these are real entry points, not doorway pages.
// - A static page per movie at movies/<slug>/ listing every theatre showing
//   it, with each format combination's dates, plus a movies/ index. These
//   don't load app.js; movie.js adds format filters (and, on movie pages,
//   reopens the visitor's province) on top.
// - Three curated city/format pages with actual session times, using native
//   date disclosure controls. LANDING_PAGES defines the bounded pilot.
// - A crawlable directory of every theatre in each page's footer, since the
//   region picker is built from buttons rather than links.
// - sitemap.xml listing every page and a root robots.txt advertising it.
//
// Every generated page carries <meta name="cinescan-routing" content="path">,
// which tells app.js to use theatres/<slug>/ URLs instead of ?theatre=<slug>
// and to link movie titles to their movies/<slug>/ pages.
//
// Run from the repo root after `data-snapshot.mjs restore`. A theatre whose
// data file is missing still gets a page, just without a now-playing list.
//
//   node scripts/build-site.mjs [out-dir]

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_URL = "https://cinescan.app/";
const COPY = ["app.js", "movie.js", "style.css", "assets", "data"];

// Deliberate pilot, not a cross-product of cities and formats. Expand only
// after Search Console has enough data to review these pages' usefulness.
const LANDING_PAGES = [
  { path: "cities/toronto/", heading: "Toronto movie showtimes", city: "Toronto", province: "ON" },
  { path: "cities/toronto/imax/", heading: "IMAX showtimes in Toronto", city: "Toronto", province: "ON", format: "IMAX" },
  { path: "formats/4dx/", heading: "4DX movies and showtimes in Canada", format: "4DX" },
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
function staticPage(template, { title, description, url, baseHref, structuredData, heading, intro, main, script = "movie.js" }) {
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
        ...(script ? [`  <script src="${script}"></script>`] : []),
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

function renderNowPlaying(theatre, movies, today) {
  if (movies.length === 0) return "";
  const items = movies.map((movie) => {
    const formats = [...movie.formats].sort().join(" · ");
    const from =
      movie.firstDate > today
        ? ` <span class="now-playing-date">from ${escapeHtml(formatDate(movie.firstDate))}</span>`
        : "";
    const href = moviePath(movieSlug(movie.title));
    return `        <li><a class="now-playing-title" href="${href}">${escapeHtml(movie.title)}</a> <span class="now-playing-formats">${escapeHtml(formats)}</span>${from}</li>`;
  });
  return [
    `<section class="now-playing">`,
    `      <h2>Now playing at ${escapeHtml(theatre.name)}</h2>`,
    `      <ul>`,
    ...items,
    `      </ul>`,
    `    </section>`,
  ].join("\n");
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
  const nowPlaying = renderNowPlaying(theatre, movies, today);
  if (nowPlaying) {
    html = replaceOnce(
      html,
      /(<main id="calendar" class="calendar">[\s\S]*?)(\n\s*<\/main>)/,
      (_, start, end) => `${start}\n    ${nowPlaying}${end}`,
      "calendar <main>"
    );
  }
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

function renderLandingNav(currentPath) {
  return `<nav class="landing-nav" aria-label="Browse showtimes">${LANDING_PAGES.map((page) =>
    `<a href="${page.path}"${page.path === currentPath ? ' aria-current="page"' : ""}>${escapeHtml(page.heading)}</a>`
  ).join(" ")}</nav>`;
}

// Keep each time attached to its date, movie, theatre and exact format
// combination. Filtering happens before grouping so other sessions of the
// same movie never leak into a format-specific answer.
function collectLandingSessions(page, theatres, dataBySlug, today) {
  const days = new Map();
  const movieSlugs = new Set();
  const theatreSlugs = new Set();
  let updatedAt = "";
  for (const theatre of theatres) {
    if (page.city && (theatre.city !== page.city || theatre.province !== page.province)) continue;
    const data = dataBySlug.get(theatre.slug);
    // Include all in-scope snapshots, even when their results are empty.
    if (data?.updatedAt > updatedAt) updatedAt = data.updatedAt;
    for (const day of data?.days ?? []) {
      if (day.date < today) continue;
      for (const movie of day.movies) {
        for (const session of movie.sessions) {
          if (page.format && !session.formats.includes(page.format)) continue;
          if (!/^\d{2}:\d{2}$/.test(session.time)) continue;
          const slug = movieSlug(movie.title);
          if (!days.has(day.date)) days.set(day.date, new Map());
          const movies = days.get(day.date);
          if (!movies.has(slug)) movies.set(slug, { slug, title: movie.title, theatres: new Map() });
          const showings = movies.get(slug).theatres;
          if (!showings.has(theatre.slug)) showings.set(theatre.slug, { theatre, combos: new Map() });
          const combos = showings.get(theatre.slug).combos;
          const formats = [...session.formats].sort();
          const key = formats.join("|");
          if (!combos.has(key)) combos.set(key, { formats, times: [] });
          combos.get(key).times.push(session.time);
          movieSlugs.add(slug);
          theatreSlugs.add(theatre.slug);
        }
      }
    }
  }
  return { days, movieSlugs, theatreSlugs, updatedAt };
}

function landingPage(template, page, results, today) {
  const { days, movieSlugs, theatreSlugs, updatedAt } = results;
  const url = SITE_URL + page.path;
  const description = `${page.heading} at Cineplex: compare movies, theatres, formats, dates and actual session times from the latest snapshot.`;
  const formatQuery = page.format ? `?formats=${encodeURIComponent(page.format)}` : "";
  const dates = [...days.keys()].sort();
  const sections = dates.map((date, index) => {
    const movies = [...days.get(date).values()].sort((a, b) => a.title.localeCompare(b.title));
    const rows = movies.map((movie) => {
      const theatres = [...movie.theatres.values()].sort((a, b) =>
        (a.theatre.city || "").localeCompare(b.theatre.city || "") || a.theatre.name.localeCompare(b.theatre.name));
      return [
        `        <section class="landing-movie">`,
        `          <h3><a href="${moviePath(movie.slug)}${formatQuery}">${escapeHtml(movie.title)}</a></h3>`,
        ...theatres.map(({ theatre, combos }) => [
          `          <section class="landing-theatre">`,
          `            <h4><a href="${theatrePath(theatre)}${formatQuery}">${escapeHtml(theatre.name)}</a> <span class="movie-theatre-city">${escapeHtml([theatre.city, theatre.province].filter(Boolean).join(", "))}</span></h4>`,
          `            <ul class="landing-sessions">`,
          ...[...combos.values()].sort((a, b) => a.formats.join().localeCompare(b.formats.join())).map(({ formats, times }) =>
            `              <li>${renderBadges(formats)} <span class="landing-times">${times.sort().map((time) => `<time datetime="${date}T${time}">${time}</time>`).join(" ")}</span></li>`),
          `            </ul>`,
          `          </section>`,
        ].join("\n")),
        `        </section>`,
      ].join("\n");
    });
    return [
      `    <details class="landing-day" id="date-${date}"${index === 0 ? " open" : ""}>`,
      `      <summary><h2><time datetime="${date}">${escapeHtml(formatDate(date))}, ${date.slice(0, 4)}</time></h2> <span>${movies.length} ${movies.length === 1 ? "movie" : "movies"}</span></summary>`,
      ...rows,
      `    </details>`,
    ].join("\n");
  });
  return staticPage(template, {
    title: `${page.heading} | CineScan`, description, url,
    baseHref: "../".repeat(page.path.split("/").length - 1),
    structuredData: { "@context": "https://schema.org", "@type": "CollectionPage", name: page.heading, url, description,
      ...(updatedAt ? { dateModified: updatedAt } : {}) },
    heading: escapeHtml(page.heading),
    intro: [
      `    <p class="refresh-note">${page.city ? "Cineplex theatres in Toronto city limits, including North York and Scarborough; surrounding GTA cities are excluded." : "4DX sessions at Cineplex theatres across Canada."}</p>`,
      `    <p class="refresh-note">Dates from ${escapeHtml(formatDate(today))}, ${today.slice(0, 4)} onward (Toronto date). Times are in each theatre's local time, in 24-hour format. Today's earlier sessions may still appear.</p>`,
      `    <p class="refresh-note">Snapshot data refreshes multiple times per day. Select a theatre for its calendar, tickets and seat availability.</p>`,
      `    <p class="updated">${movieSlugs.size} movies · ${theatreSlugs.size} theatres · ${dates.length} dates${updatedAt ? ` · Latest snapshot: <time datetime="${escapeHtml(updatedAt)}">${escapeHtml(updatedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC"))}</time>` : ""}</p>`,
    ].join("\n"),
    main: [
      `<main class="landing-page">`,
      renderLandingNav(page.path),
      ...(dates.length > 1 ? [
        `    <details class="landing-date-picker"><summary>Jump to a date (${dates.length} available)</summary>`,
        `      <nav class="landing-nav" aria-label="Available dates">${dates.map((date) => `<a href="${page.path}#date-${date}">${escapeHtml(formatDate(date))}, ${date.slice(0, 4)}</a>`).join(" ")}</nav>`,
        `    </details>`,
      ] : []),
      ...(sections.length ? sections : [
        `    <section class="landing-empty"><h2>No matching showtimes in this snapshot</h2>`,
        `      <p>No ${page.format ? escapeHtml(page.format) + " " : ""}sessions are listed for ${page.city ? "Toronto" : "Canada"} from today onward. Schedules can be added later, and a missing listing does not mean a theatre is closed or a format is unavailable.</p>`,
        `      <p><a href="movies/">Browse all movies</a> or <a href="./">check a theatre calendar</a>, and check back after the next update.</p></section>`,
      ]),
      `  </main>`,
    ].join("\n"),
    script: null, // Native disclosure controls work without JavaScript.
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
    () => renderLandingNav() + "\n    " + renderDirectory(theatres),
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

  const landingEntries = [];
  for (const page of LANDING_PAGES) {
    const results = collectLandingSessions(page, theatres, dataBySlug, today);
    await writePage(outDir, page.path, landingPage(shared, page, results, today));
    landingEntries.push({ url: SITE_URL + page.path, lastmod: results.updatedAt });
  }

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
      ...landingEntries,
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
