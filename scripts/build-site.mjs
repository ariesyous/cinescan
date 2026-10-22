// Builds the deployable site into an output directory (default `_site/`)
// for .github/workflows/pages.yml. The checkout itself stays a working,
// build-free site served as-is; this only adds what search engines need on
// top of it:
//
// - A static page per theatre at theatres/<slug>/ with its own title,
//   description, canonical URL, structured data and a crawlable now-playing
//   list. Each is the same app as index.html (app.js swaps in the full
//   calendar on load), so these are real entry points, not doorway pages.
// - A crawlable directory of every theatre in each page's footer, since the
//   region picker is built from buttons rather than links.
// - sitemap.xml listing the home page and every theatre page. GitHub Pages
//   project sites can't serve a root robots.txt, so submit it via Google
//   Search Console instead.
//
// Every generated page carries <meta name="cinescan-routing" content="path">,
// which tells app.js to use theatres/<slug>/ URLs instead of ?theatre=<slug>.
//
// Run from the repo root after `data-snapshot.mjs restore`. A theatre whose
// data file is missing still gets a page, just without a now-playing list.
//
//   node scripts/build-site.mjs [out-dir]

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const SITE_URL = "https://ariesyous.github.io/cinescan/";
const COPY = ["app.js", "style.css", "assets", "data"];

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

// "YYYY-MM-DD" for today in Toronto, matching the dates the scraper writes.
function todayInToronto() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

function formatDate(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).toLocaleDateString("en-CA", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
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
          formatCounts.set(tag, (formatCounts.get(tag) || 0) + 1);
        }
      }
    }
  }
  const sorted = [...movies.values()].sort(
    (a, b) => a.firstDate.localeCompare(b.firstDate) || a.title.localeCompare(b.title)
  );
  const formats = [...formatCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
  return { movies: sorted, formats };
}

function renderNowPlaying(theatre, movies, today) {
  if (movies.length === 0) return "";
  const items = movies.map((movie) => {
    const formats = [...movie.formats].sort().join(" · ");
    const from =
      movie.firstDate > today
        ? ` <span class="now-playing-date">from ${escapeHtml(formatDate(movie.firstDate))}</span>`
        : "";
    return `        <li><span class="now-playing-title">${escapeHtml(movie.title)}</span> <span class="now-playing-formats">${escapeHtml(formats)}</span>${from}</li>`;
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

function renderDirectory(theatres) {
  const byProvince = new Map();
  for (const t of theatres) {
    const key = t.province || "";
    if (!byProvince.has(key)) byProvince.set(key, []);
    byProvince.get(key).push(t);
  }
  const provinces = [...byProvince.keys()].sort((a, b) =>
    provinceName(a).localeCompare(provinceName(b))
  );

  const groups = provinces.map((province) => {
    const links = byProvince
      .get(province)
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

  const directory = renderDirectory(theatres);
  const withDirectory = replaceOnce(
    template,
    /<!--THEATRE_DIRECTORY-->/,
    () => directory,
    "<!--THEATRE_DIRECTORY--> placeholder"
  );

  const entries = [];
  let missing = 0;
  for (const theatre of theatres) {
    const data = await readJson(theatre.file);
    if (!data) missing++;
    const dir = path.join(outDir, theatrePath(theatre));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.html"), theatrePage(withDirectory, theatre, data, today));
    entries.push({ url: SITE_URL + theatrePath(theatre), lastmod: data?.updatedAt });
  }

  const latest = entries.map((e) => e.lastmod).filter(Boolean).sort().at(-1);
  entries.unshift({ url: SITE_URL, lastmod: latest });

  await writeFile(path.join(outDir, "index.html"), homePage(withDirectory));
  await writeFile(path.join(outDir, "sitemap.xml"), sitemap(entries));

  console.log(
    `Built ${theatres.length} theatre pages into ${rel}` +
      (missing ? ` (${missing} without data files)` : "")
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
