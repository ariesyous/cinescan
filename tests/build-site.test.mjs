import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repo, "scripts/build-site.mjs");
const SITE = "https://cinescan.app/";
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const read = (root, file) => readFileSync(path.join(root, "out", file), "utf8");

// Builds against the real index.html/app.js/style.css so template drift fails here first.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cinescan-site-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ["index.html", "app.js", "movie.js", "seatmap.js", "style.css", "assets"]) {
    cpSync(path.join(repo, entry), path.join(root, entry), { recursive: true });
  }
  mkdirSync(path.join(root, "data"));
  writeFileSync(path.join(root, "data/theatres.json"), JSON.stringify([
    { id: 1, slug: "big-screen", name: "Big Screen & VIP", city: "Toronto", province: "ON", metro: "GTA", file: "data/big-screen.json" },
    { id: 2, slug: "no-data", name: "No Data Cinema", city: "Regina", province: "SK", metro: null, file: "data/no-data.json" },
    { id: 3, slug: "petit-ecran", name: "Petit Écran", city: "Montréal", province: "QC", metro: "Montreal", file: "data/petit-ecran.json" },
  ]));
  const movie = (title, ...formatLists) => ({
    title,
    poster: "https://example.test/poster.jpg",
    runtimeMinutes: 125,
    sessions: formatLists.map((formats) => ({ time: "19:00", formats })),
  });
  writeFileSync(path.join(root, "data/big-screen.json"), JSON.stringify({
    updatedAt: "2026-10-07T00:00:00.000Z",
    days: [
      { date: "2000-01-01", movies: [movie("Gone Already", ["Regular"])] },
      { date: today, movies: [movie("Now Showing", ["IMAX", "Regular"])] },
      { date: "2099-12-18", movies: [movie("Advance <Sale>", ["UltraAVX"])] },
    ],
  }));
  writeFileSync(path.join(root, "data/petit-ecran.json"), JSON.stringify({
    updatedAt: "2026-10-08T00:00:00.000Z",
    days: [
      { date: today, movies: [movie("Now Shówing", ["Regular"], ["3D", "Regular"])] },
      { date: "2099-01-02", movies: [movie("Now Showing", ["Regular"])] },
    ],
  }));
  return root;
}

test("builds theatre pages, home page and sitemap", (t) => {
  const root = fixture(t);
  const result = run(root, "out");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Built 3 theatre pages and 2 movie pages into out \(1 theatres without data files\)/);

  const page = read(root, "theatres/big-screen/index.html");
  assert.match(page, /<title>Big Screen &amp; VIP Showtimes \| CineScan<\/title>/);
  assert.match(page, new RegExp(`<link rel="canonical" href="${SITE}theatres/big-screen/" />`));
  assert.match(page, /<base href="\.\.\/\.\.\/" \/>/);
  assert.match(page, /<meta name="cinescan-routing" content="path" \/>/);
  assert.match(page, /2 movies, including IMAX and UltraAVX screenings/);
  assert.match(page, /<h1 id="theatre-name">Showtimes at Big Screen &amp; VIP<\/h1>/);
  assert.match(page, /<a class="now-playing-title" href="movies\/now-showing\/">Now Showing<\/a> <span class="now-playing-formats">IMAX · Regular<\/span><\/li>/);
  assert.match(page, /href="movies\/advance-sale\/">Advance &lt;Sale&gt;<\/a>.*from /);
  assert.doesNotMatch(page, /Gone Already/);
  assert.match(page, /"addressRegion": "ON"/);
  assert.match(page, /<a href="theatres\/no-data\/">No Data Cinema<\/a>/);
  assert.match(page, /<span class="brand-nav"> &middot; <a href="movies\/">Browse movies<\/a><\/span>/);

  const bare = read(root, "theatres/no-data/index.html");
  assert.doesNotMatch(bare, /now-playing/);
  assert.match(bare, /<p class="loading">/);

  const home = read(root, "index.html");
  assert.match(home, /<base href="\.\/" \/>/);
  assert.match(home, new RegExp(`<link rel="canonical" href="${SITE}" />`));
  assert.match(home, /"@type": "WebSite"/);
  assert.match(home, /All 3 Cineplex theatres in Canada/);

  const sitemap = read(root, "sitemap.xml");
  assert.equal(sitemap.match(/<url>/g).length, 7);
  assert.match(sitemap, new RegExp(`<loc>${SITE}</loc><lastmod>2026-10-08T00:00:00.000Z</lastmod>`));
  assert.match(sitemap, new RegExp(`<loc>${SITE}movies/</loc>`));
  assert.match(sitemap, new RegExp(`<loc>${SITE}movies/now-showing/</loc><lastmod>2026-10-08T00:00:00.000Z</lastmod>`));
  assert.match(sitemap, new RegExp(`<loc>${SITE}theatres/no-data/</loc></url>`));
  assert.doesNotMatch(sitemap, /gone-already/);
  assert.equal(read(root, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`);

  for (const html of [home, page, bare, read(root, "movies/index.html"), read(root, "movies/now-showing/index.html")]) {
    assert.ok(html.includes(`content="${SITE}assets/cinescan-social-preview.jpg"`));
    assert.ok(!html.includes("ariesyous.github.io"));
  }

  // app.js builds the date bar and search combobox inside elements the template provides.
  for (const html of [home, page, bare]) {
    assert.match(html, /<nav id="date-bar" class="date-bar" aria-label="Jump to a date" hidden><\/nav>/);
    assert.match(html, /<input\s+id="theatre-search"[^>]*role="combobox"/);
  }

  for (const copied of ["app.js", "movie.js", "seatmap.js", "style.css", "assets/favicon.svg", "data/big-screen.json"]) {
    assert.ok(existsSync(path.join(root, "out", copied)), copied);
  }
});

test("builds a page per movie across theatres, and a movies index", (t) => {
  const root = fixture(t);
  assert.equal(run(root, "out").status, 0);
  assert.ok(!existsSync(path.join(root, "out/movies/gone-already")));

  // "Now Shówing" and "Now Showing" share a slug, so they share a page.
  const page = read(root, "movies/now-showing/index.html");
  assert.match(page, /<title>Now Showing — Cineplex Showtimes in Canada \| CineScan<\/title>/);
  assert.match(page, new RegExp(`<link rel="canonical" href="${SITE}movies/now-showing/" />`));
  assert.match(page, /<base href="\.\.\/\.\.\/" \/>/);
  assert.match(page, /"@type": "Movie"/);
  assert.match(page, /"duration": "PT125M"/);
  assert.match(page, /2 theatres across Canada, including 3D and IMAX/);
  assert.match(page, /Playing at 2 theatres · 2h 5m · /);
  assert.match(page, /data-tag="Regular">Regular <span class="chip-count">2<\/span>/);
  assert.match(page, /data-tag="IMAX">IMAX <span class="chip-count">1<\/span>/);
  assert.match(page, /<script src="movie.js"><\/script>/);
  assert.doesNotMatch(page, /<script src="app.js">/);
  assert.match(page, /All 3 Cineplex theatres in Canada/); // shared footer

  // Grouped by province (ties by name), with each format combination's own
  // dates; a small release starts expanded.
  assert.ok(page.indexOf("<h2>Ontario</h2>") < page.indexOf("<h2>Quebec</h2>"));
  assert.match(page, /<details class="movie-province" data-province="QC" open>\n      <summary><h2>Quebec<\/h2> <span class="movie-province-count">1 theatre<\/span><\/summary>/);
  assert.match(page, /<a href="theatres\/petit-ecran\/" data-theatre-link>Petit Écran<\/a> <span class="movie-theatre-city">Montréal<\/span>/);
  assert.match(page, /<li data-formats="Regular">.*Jan 2 · 2 days<\/span><\/li>/);
  assert.match(page, /<li data-formats="3D\|Regular">.*only<\/span><\/li>/);
  assert.match(page, /<li data-formats="IMAX\|Regular">/);
  assert.doesNotMatch(page, /<a href="theatres\/no-data\/" data-theatre-link>/);

  const advance = read(root, "movies/advance-sale/index.html");
  assert.match(advance, /<h1>Advance &lt;Sale&gt; <span class="heading-sub">/);
  assert.match(advance, /Fri, Dec 18 only/);

  const index = read(root, "movies/index.html");
  assert.match(index, /<base href="\.\.\/" \/>/);
  assert.match(index, /1 movies now playing and 1 coming soon/);
  assert.match(index, /"@type": "ItemList"/);
  assert.match(index, new RegExp(`"url": "${SITE}movies/advance-sale/"`));
  assert.ok(index.indexOf("<h2>Now playing</h2>") < index.indexOf('href="movies/now-showing/"'));
  assert.ok(index.indexOf("<h2>Coming soon</h2>") < index.indexOf('href="movies/advance-sale/"'));
  assert.match(index, /Opens Fri, Dec 18 · 1 theatre/);

  // Format filter chips count movies; cards carry what movie.js filters on.
  assert.match(index, /<div id="movie-filter" class="format-filter movie-filter" hidden>/);
  assert.match(index, /data-tag="Regular">Regular <span class="chip-count">1<\/span>/);
  assert.match(index, /data-tag="UltraAVX">UltraAVX <span class="chip-count">1<\/span>/);
  assert.match(index, /<li data-formats="Regular\|3D\|IMAX" data-counts="\{&quot;IMAX&quot;:1,&quot;Regular&quot;:2,&quot;3D&quot;:1\}" data-opens="">/);
  assert.match(index, /data-opens="Opens Fri, Dec 18">/);

  const notFound = read(root, "404.html");
  assert.match(notFound, /<base href="\/" \/>/);
  assert.match(notFound, /<a href="movies\/">Browse movies now playing<\/a>/);
});

test("collapses wide releases, biggest province first, and hides extra badges", (t) => {
  const root = fixture(t);
  const theatres = [];
  const formats = ["Regular", "IMAX", "UltraAVX", "ScreenX", "4DX", "70mm"];
  for (const [i, province] of ["ON", "ON", "QC", "QC", "QC", "SK", "AB"].entries()) {
    const slug = `theatre-${i}`;
    theatres.push({ id: 100 + i, slug, name: `Theatre ${i}`, city: `City ${i}`, province, metro: null, file: `data/${slug}.json` });
    writeFileSync(path.join(root, `data/${slug}.json`), JSON.stringify({
      updatedAt: "2026-10-07T00:00:00.000Z",
      days: [{ date: today, movies: [{ title: "Wide Release", sessions: formats.map((f) => ({ time: "19:00", formats: [f] })) }] }],
    }));
  }
  writeFileSync(path.join(root, "data/theatres.json"), JSON.stringify(theatres));
  assert.equal(run(root, "out").status, 0);

  const page = read(root, "movies/wide-release/index.html");
  const order = [...page.matchAll(/data-province="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["QC", "ON", "AB", "SK"]);
  assert.doesNotMatch(page, /<details[^>]* open>/);
  assert.match(page, /<h2>Quebec<\/h2> <span class="movie-province-count">3 theatres<\/span>/);

  // Top four premium formats show, the rest wait for movie.js to reveal them.
  const index = read(root, "movies/index.html");
  const badges = [...index.matchAll(/<span class="format-badge [^"]*" data-tag="([^"]+)"( data-extra hidden)?>/g)];
  assert.deepEqual(badges.map((m) => [m[1], Boolean(m[2])]), [
    ["4DX", false], ["70mm", false], ["IMAX", false], ["ScreenX", false], ["UltraAVX", true],
  ]);
});

test("fails when index.html no longer has a placeholder", (t) => {
  for (const placeholder of ["<!--SITE_HEAD-->", "<!--SITE_NAV-->", "<!--THEATRE_DIRECTORY-->"]) {
    const root = fixture(t);
    const index = path.join(root, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(placeholder, ""));
    const result = run(root, "out");
    assert.notEqual(result.status, 0, placeholder);
    assert.match(result.stderr, new RegExp(placeholder.slice(4, -3)));
  }
});

test("refuses to build over the source tree", (t) => {
  const root = fixture(t);
  for (const out of [".", ".."]) {
    const result = run(root, out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to build/);
  }
  assert.ok(existsSync(path.join(root, "index.html")));
});

test("collapses a long format filter behind a toggle, and leaves a short one alone", (t) => {
  const short = fixture(t);
  assert.equal(run(short, "out").status, 0);
  for (const file of ["movies/index.html", "movies/now-showing/index.html"]) {
    const page = read(short, file);
    assert.match(page, /<div class="movie-filter-wrap">/, file);
    assert.doesNotMatch(page, /filter-toggle/, file);
  }

  const long = fixture(t);
  const formats = ["Regular", "IMAX", "UltraAVX", "ScreenX", "4DX", "70mm", "3D"];
  writeFileSync(path.join(long, "data/theatres.json"), JSON.stringify([
    { id: 100, slug: "wide", name: "Wide", city: "City", province: "ON", metro: null, file: "data/wide.json" },
  ]));
  writeFileSync(path.join(long, "data/wide.json"), JSON.stringify({
    updatedAt: "2026-10-07T00:00:00.000Z",
    days: [{ date: today, movies: [{ title: "Wide Release", sessions: formats.map((f) => ({ time: "19:00", formats: [f] })) }] }],
  }));
  assert.equal(run(long, "out").status, 0);
  for (const file of ["movies/index.html", "movies/wide-release/index.html"]) {
    const page = read(long, file);
    assert.match(page, /<div class="movie-filter-wrap collapsible">/, file);
    assert.match(page, /<button type="button" id="movie-filter-toggle" class="filter-toggle" aria-expanded="false" aria-controls="movie-filter" hidden>/, file);
    assert.match(page, /<span class="filter-toggle-state">All formats<\/span>/, file);
    // movie.js still finds the same filter element and chips inside the wrapper.
    assert.match(page, /<div id="movie-filter" class="format-filter movie-filter" hidden>/, file);
    assert.equal(page.match(/class="format-chip /g).length, formats.length, file);
  }
});

test("writes each movie's showtimes beside its page, and marks the page for movie.js", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "data/petit-ecran.json"), JSON.stringify({
    updatedAt: "2026-10-08T00:00:00.000Z",
    auditoriums: { 77: { totalRows: 1, totalColumns: 2, rowLabels: ["A"], seatTypes: ["SS"] } },
    days: [
      { date: "2000-01-01", movies: [{ title: "Now Showing", sessions: [{ time: "10:00", formats: ["Regular"] }] }] },
      {
        date: today,
        movies: [{
          title: "Now Shówing",
          sessions: [
            { time: "21:15", formats: ["Regular"], ticketUrl: "https://tickets.test/b" },
            { time: "19:00", formats: ["IMAX", "3D"], ticketUrl: "https://tickets.test/a", layoutKey: "77", seats: ["AO"] },
            { time: "20:00", formats: ["Regular"], ticketUrl: "javascript:alert(1)", layoutKey: "77", seats: ["AO"] },
            { time: "22:30", formats: ["Regular"], ticketUrl: "https://tickets.test/c", layoutKey: "404", seats: ["AO"] },
          ],
        }],
      },
      { date: "2099-01-02", movies: [{ title: "Now Showing", sessions: [{ time: "09:30", formats: ["Regular"] }] }] },
    ],
  }));
  assert.equal(run(root, "out").status, 0);

  // One entry per theatre showing it: sessions in time order, formats as
  // indexes into `combos`, no past days, and no link that isn't a web link.
  // A trailing 1 marks a session whose seat map the theatre's file has, which
  // needs both a web link (movie.js finds the seats by it) and a layout for
  // its seats: the 20:00 session has no usable link and 22:30 no layout.
  const showtimes = JSON.parse(read(root, "movies/now-showing/showtimes.json"));
  assert.equal(showtimes.updatedAt, "2026-10-08T00:00:00.000Z");
  assert.deepEqual(showtimes.combos, [["IMAX", "Regular"], ["3D", "IMAX"], ["Regular"]]);
  assert.deepEqual(Object.keys(showtimes.theatres), ["big-screen", "petit-ecran"]);
  assert.deepEqual(showtimes.theatres["big-screen"], {
    tz: "America/Toronto",
    days: { [today]: [["19:00", 0]] },
  });
  assert.deepEqual(showtimes.theatres["petit-ecran"], {
    tz: "America/Toronto",
    days: {
      [today]: [
        ["19:00", 1, "https://tickets.test/a", 1],
        ["20:00", 2],
        ["21:15", 2, "https://tickets.test/b"],
        ["22:30", 2, "https://tickets.test/c"],
      ],
      "2099-01-02": [["09:30", 2]],
    },
  });
  assert.ok(existsSync(path.join(root, "out/movies/advance-sale/showtimes.json")));
  assert.ok(!existsSync(path.join(root, "out/movies/gone-already")));
  assert.doesNotMatch(read(root, "sitemap.xml"), /showtimes\.json/);

  // The hooks movie.js finds its way around by. The day strip must sit
  // outside <header> to stick to the top as the page scrolls.
  const page = read(root, "movies/now-showing/index.html");
  assert.match(page, /<nav id="movie-day-bar" class="date-bar movie-day-bar" aria-label="Show a single day" hidden><\/nav>/);
  assert.match(page, /<main class="movie-page" data-movie="now-showing" data-showtimes="movies\/now-showing\/showtimes.json">/);
  assert.match(page, /<li class="movie-theatre" data-theatre="petit-ecran">/);
  assert.ok(page.indexOf("</header>") < page.indexOf('id="movie-day-bar"'));
  assert.ok(page.indexOf('id="movie-day-bar"') < page.indexOf('<main class="movie-page"'));
  assert.doesNotMatch(read(root, "movies/index.html"), /movie-day-bar/);
});

// movie.js is a browser script, but with no page to set up it only defines
// functions, so its showtime logic can be exercised here.
function loadMovieScript() {
  const context = { document: { getElementById: () => null, querySelector: () => null }, location: { search: "" } };
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(repo, "movie.js"), "utf8"), context);
  // Results come from another realm, which deepStrictEqual won't compare.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return { ...context, plain };
}

test("movie.js lists a theatre's showtimes by day and format", () => {
  const { theatreDays, plain } = loadMovieScript();
  const combos = [["Regular"], ["3D", "IMAX"], ["Stars & Strollers"]];
  const entry = {
    tz: "America/Toronto",
    days: {
      "2026-11-03": [["19:00", 0]],
      "2026-11-04": [["13:00", 0, "https://tickets.test/1", 1], ["16:00", 0], ["19:30", 1, "https://tickets.test/2", 1]],
      "2026-11-06": [["20:00", 1], ["11:00", 2]],
    },
  };
  const now = { date: "2026-11-04", time: "17:00" };

  // Days before today at the theatre are dropped, and today's finished
  // sessions are marked; rows are one format combination each, earliest first.
  // Sessions marked in the file as having a seat map say so.
  assert.deepEqual(plain(theatreDays(entry, combos, new Set(), now)), [
    {
      date: "2026-11-04",
      today: true,
      rows: [
        { formats: ["Regular"], sessions: [
          { time: "13:00", url: "https://tickets.test/1", seats: true, past: true },
          { time: "16:00", seats: false, past: true },
        ] },
        { formats: ["3D", "IMAX"], sessions: [{ time: "19:30", url: "https://tickets.test/2", seats: true, past: false }] },
      ],
    },
    {
      date: "2026-11-06",
      today: false,
      rows: [
        { formats: ["Stars & Strollers"], sessions: [{ time: "11:00", seats: false, past: false }] },
        { formats: ["3D", "IMAX"], sessions: [{ time: "20:00", seats: false, past: false }] },
      ],
    },
  ]);

  // Chosen formats keep any session in at least one of them, and a day left
  // with nothing drops out.
  const imax = plain(theatreDays(entry, combos, new Set(["IMAX"]), now));
  assert.deepEqual(imax.map((day) => [day.date, day.rows.map((row) => row.formats.join("+"))]), [
    ["2026-11-04", ["3D+IMAX"]],
    ["2026-11-06", ["3D+IMAX"]],
  ]);
  const strollers = plain(theatreDays(entry, combos, new Set(["Stars & Strollers"]), now));
  assert.deepEqual(strollers.map((day) => day.date), ["2026-11-06"]);
  assert.deepEqual(plain(theatreDays(entry, combos, new Set(["4DX"]), now)), []);

  // Once today is over at the theatre it's no longer listed.
  const tomorrow = plain(theatreDays(entry, combos, new Set(), { date: "2026-11-05", time: "00:10" }));
  assert.deepEqual(tomorrow.map((day) => day.date), ["2026-11-06"]);
});

test("movie.js reads the clock where the theatre is", () => {
  const { clockAt, formatTimeLabel, formatDayLabel, plain } = loadMovieScript();

  // 02:30 UTC on Nov 5 is still the evening of Nov 4 in Saskatchewan, which
  // keeps UTC-6 all year (zones that observe daylight saving would make this
  // test depend on the time zone database), but already the 5th in Tokyo.
  const instant = new Date("2026-11-05T02:30:00Z");
  assert.deepEqual(plain(clockAt("America/Regina", instant)), { date: "2026-11-04", time: "20:30" });
  assert.deepEqual(plain(clockAt("Asia/Tokyo", instant)), { date: "2026-11-05", time: "11:30" });
  // Midnight is 00:00, never 24:00, so it compares correctly with showtimes.
  assert.deepEqual(plain(clockAt("UTC", new Date("2026-11-05T00:00:00Z"))), { date: "2026-11-05", time: "00:00" });

  assert.equal(formatTimeLabel("14:10"), "2:10 PM");
  assert.equal(formatTimeLabel("00:05"), "12:05 AM");
  assert.equal(formatTimeLabel("12:00"), "12:00 PM");
  assert.equal(formatDayLabel("2026-11-05"), "Thu, Nov 5");
});

test("movie pages and the theatre page load seatmap.js before the script that uses it", (t) => {
  const root = fixture(t);
  assert.equal(run(root, "out").status, 0);
  assert.ok(existsSync(path.join(root, "out/seatmap.js")));

  // Each page's own scripts in the order they load (the analytics tag isn't one).
  const scripts = (html) => [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(scripts(read(root, "index.html")), ["seatmap.js", "app.js"]);
  assert.deepEqual(scripts(read(root, "theatres/big-screen/index.html")), ["seatmap.js", "app.js"]);
  assert.deepEqual(scripts(read(root, "movies/now-showing/index.html")), ["seatmap.js", "movie.js"]);
  // No times to hover on these.
  assert.deepEqual(scripts(read(root, "movies/index.html")), ["movie.js"]);
  assert.deepEqual(scripts(read(root, "404.html")), ["movie.js"]);
});

// seatmap.js is a browser script too, but it touches nothing on the page until
// a map is shown, so its helpers can be exercised here.
function loadSeatMap() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(readFileSync(path.join(repo, "seatmap.js"), "utf8"), context);
  return vm.runInContext("SeatMap", context);
}

test("seatmap.js works out when a film ends and how each seat looks", () => {
  const { endTimeLabel, formatRuntime, seatClass } = loadSeatMap();

  assert.equal(endTimeLabel("19:30", 125), "9:35 PM");
  assert.equal(endTimeLabel("23:30", 125), "1:35 AM"); // after midnight
  assert.equal(endTimeLabel("12:00", 60), "1:00 PM");
  assert.equal(endTimeLabel("19:30", 0), ""); // runtime unknown
  assert.equal(formatRuntime(125), "2h 5m");
  assert.equal(formatRuntime(120), "2h");
  assert.equal(formatRuntime(45), "45m");

  // Only an available seat shows what kind it is; "?" and "." both draw nothing.
  assert.equal(seatClass("A", "S"), "seat seat-available");
  assert.equal(seatClass("A", "W"), "seat seat-available-accessible");
  assert.equal(seatClass("A", "C"), "seat seat-available-accessible");
  assert.equal(seatClass("A", "D"), "seat seat-available-dbox");
  assert.equal(seatClass("O", "D"), "seat seat-occupied");
  assert.equal(seatClass("?", "S"), "seat seat-none");
  assert.equal(seatClass(".", "."), "seat seat-none");
});

test("movie.js finds a session's seat map by its ticket link", () => {
  const { indexSeatFile, plain } = loadMovieScript();
  const layout = { totalRows: 1, totalColumns: 3, rowLabels: ["A"], seatTypes: ["SDS"] };
  const file = indexSeatFile({
    updatedAt: "2026-11-04T22:03:00.000Z",
    auditoriums: { 160721: layout },
    days: [{
      date: "2026-11-04",
      movies: [{
        title: "Gueule d'Argile",
        runtimeMinutes: 105,
        sessions: [
          // One showing sold as two areas, regular and D-BOX: the same seats under different links.
          { time: "19:15", formats: ["D-BOX", "Recliner"], ticketUrl: "https://tickets.test/dbox", layoutKey: "160721", seats: ["AOA"] },
          { time: "19:15", formats: ["Recliner"], ticketUrl: "https://tickets.test/regular", layoutKey: "160721", seats: ["AOA"] },
          // No seat map: sold out, or one whose layout didn't come through.
          { time: "21:00", formats: ["Recliner"], ticketUrl: "https://tickets.test/sold-out" },
          { time: "22:00", formats: ["Recliner"], ticketUrl: "https://tickets.test/no-layout", layoutKey: "999", seats: ["AOA"] },
        ],
      }],
    }],
  });

  assert.deepEqual([...file.bySession.keys()], ["https://tickets.test/dbox", "https://tickets.test/regular"]);
  assert.deepEqual(plain(file.bySession.get("https://tickets.test/regular")), { layout, seats: ["AOA"], runtimeMinutes: 105 });
  // When the seats were last scraped, in Toronto time like the theatre page says it.
  assert.match(file.asOf, /^Nov 4, 2026, 5:03\sPM EST$/);

  const empty = indexSeatFile({});
  assert.equal(empty.bySession.size, 0);
  assert.equal(empty.asOf, "");
});

test("every theatre's data file is data/<slug>.json, where movie.js looks for its seat maps", () => {
  const theatres = JSON.parse(readFileSync(path.join(repo, "data/theatres.json"), "utf8"));
  assert.ok(theatres.length > 0);
  for (const theatre of theatres) assert.equal(theatre.file, `data/${theatre.slug}.json`, theatre.slug);
});

test("movie pages for many theatres get a box to find one by name", (t) => {
  const withTheatres = (count) => {
    const root = fixture(t);
    const theatres = [];
    for (let i = 0; i < count; i++) {
      const slug = `theatre-${i}`;
      theatres.push({ id: 100 + i, slug, name: `Theatre ${i}`, city: `City ${i}`, province: "ON", metro: null, file: `data/${slug}.json` });
      writeFileSync(path.join(root, `data/${slug}.json`), JSON.stringify({
        updatedAt: "2026-10-07T00:00:00.000Z",
        days: [{ date: today, movies: [{ title: "Wide Release", sessions: [{ time: "19:00", formats: ["Regular"] }] }] }],
      }));
    }
    writeFileSync(path.join(root, "data/theatres.json"), JSON.stringify(theatres));
    assert.equal(run(root, "out").status, 0);
    return read(root, "movies/wide-release/index.html");
  };

  // The box sits between the format chips and the count it updates, and
  // starts hidden like the chips, for movie.js to show.
  const many = withTheatres(13);
  assert.match(many, /<input id="movie-search" class="theatre-search movie-search" type="search" [^>]*aria-label="Find a theatre or city"[^>]* hidden \/>\n    <p id="movie-count" class="updated" aria-live="polite"><\/p>/);
  assert.ok(many.indexOf('id="movie-filter"') < many.indexOf('id="movie-search"'));
  assert.doesNotMatch(withTheatres(12), /movie-search/);
});
