import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

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
  for (const entry of ["index.html", "app.js", "movie.js", "landing.js", "seat-map.js", "style.css", "assets"]) {
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
  assert.equal(sitemap.match(/<url>/g).length, 10);
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

  for (const copied of ["app.js", "movie.js", "landing.js", "seat-map.js", "style.css", "assets/favicon.svg", "data/big-screen.json"]) {
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

test("curated landing pages keep actual times with the matching city, date and format", (t) => {
  const root = fixture(t);
  const file = path.join(root, "data/big-screen.json");
  const data = JSON.parse(readFileSync(file, "utf8"));
  data.days = [
    { date: "2000-01-01", movies: [{ title: "Expired IMAX", sessions: [{ time: "23:59", formats: ["IMAX", "4DX"] }] }] },
    { date: today, movies: [
      { title: 'Shared <Movie> & "Friends"', poster: "https://example.test/shared.jpg", sessions: [
        { time: "21:45", formats: ["IMAX", "3D"], layoutKey: "late", seats: ["AO"], ticketUrl: "https://example.test/ticket?one=1&two=2" },
        { time: "10:05", formats: ["3D", "IMAX"], layoutKey: "early", seats: ["AA"] },
        { time: "14:20", formats: ["Regular"] },
        { time: "16:30", formats: ["4DX", "3D"] },
      ] },
      { title: "Regular Only", sessions: [{ time: "18:15", formats: ["Regular"] }] },
      { title: "No Sessions", sessions: [] },
    ] },
    { date: "2099-12-18", movies: [{ title: "Advance IMAX", sessions: [{ time: "00:15", formats: ["IMAX"] }] }] },
  ];
  data.auditoriums = { early: { totalColumns: 2, seatTypes: ["SS"] }, late: { totalColumns: 2, seatTypes: ["SD"] } };
  writeFileSync(file, JSON.stringify(data));
  // Same movie and format outside Toronto must not leak into city pages.
  const outside = path.join(root, "data/petit-ecran.json");
  writeFileSync(outside, JSON.stringify({ updatedAt: "2026-10-08T00:00:00.000Z", days: [
    { date: today, movies: [{ title: 'Shared <Movie> & "Friends"', sessions: [
      { time: "22:22", formats: ["IMAX"] }, { time: "23:23", formats: ["4DX"] },
    ] }] },
  ] }));
  const manifest = path.join(root, "data/theatres.json");
  const theatres = JSON.parse(readFileSync(manifest, "utf8"));
  theatres.push({ ...theatres[2], id: 4, slug: "gta-cinema", name: "GTA Cinema", city: "Vaughan", province: "ON", metro: "GTA", file: "data/gta-cinema.json" });
  writeFileSync(manifest, JSON.stringify(theatres));
  writeFileSync(path.join(root, "data/gta-cinema.json"), JSON.stringify({days: [
    {date: today, movies: [{title: "Outside City", sessions: [{time: "20:20", formats: ["IMAX"]}]}]},
  ]}));
  assert.equal(run(root, "out").status, 0);

  const toronto = read(root, "cities/toronto/index.html");
  const imax = read(root, "cities/toronto/imax/index.html");
  const fourDx = read(root, "formats/4dx/index.html");
  const main = (html) => html.match(/<main class="calendar landing-page">[\s\S]*?<\/main>/)[0];
  assert.match(main(toronto), /Regular Only/);
  assert.match(main(toronto), /14:20/);
  assert.match(main(toronto), /16:30/);
  assert.match(main(toronto), /Shared &lt;Movie&gt; &amp; &quot;Friends&quot;/);
  assert.match(main(imax), new RegExp(`<time datetime="${today}T10:05">10:05 AM</time>`));
  assert.ok(main(imax).indexOf("10:05") < main(imax).indexOf("21:45"));
  assert.match(main(imax), /2099-12-18T00:15/);
  assert.match(main(imax), /tag-3d">3D/);
  assert.match(main(imax), /href="theatres\/big-screen\/\?formats=IMAX"/);
  assert.match(main(imax), /href="movies\/shared-movie-and-friends\/\?formats=IMAX"/);
  assert.doesNotMatch(main(imax), /14:20|16:30|22:22|23:23|Regular Only|Outside City|No Sessions|Expired IMAX/);
  assert.doesNotMatch(main(toronto), /22:22|23:23|Outside City|No Sessions|Expired IMAX/);
  assert.match(main(fourDx), /16:30/);
  assert.match(main(fourDx), /23:23/);
  assert.match(main(fourDx), /Montréal, QC/);
  assert.doesNotMatch(main(fourDx), /10:05|21:45|14:20|22:22|Advance IMAX|Expired IMAX/);
  assert.match(imax, /<base href="\.\.\/\.\.\/\.\.\/"/);
  assert.match(toronto, /<base href="\.\.\/\.\.\/"/);
  assert.match(imax, /<title>IMAX showtimes in Toronto \| CineScan<\/title>/);
  assert.match(imax, /Times are local to each theatre/);
  assert.equal((main(imax).match(/class="day-card"/g) || []).length, 2);
  assert.match(main(imax), /class="movie"/);
  assert.match(main(imax), /class="movie-info"/);
  assert.match(main(imax), /<img src="https:\/\/example.test\/shared.jpg" alt="" loading="lazy" \/>/);
  assert.match(main(imax), /class="movie-title"/);
  assert.match(main(imax), /class="session-wrap"><a class="session has-seats"[^>]*><time[^>]*>10:05 AM<\/time><\/a><span class="format-badges">/);
  assert.doesNotMatch(imax, /<script src="(?:app|movie).js"/);
  assert.match(imax, /<script src="seat-map.js"><\/script>\n  <script src="landing.js"><\/script>/);
  assert.match(main(imax), /data-session="1,0,1" data-layout="early"><time[^>]+>10:05/);
  assert.match(main(imax), /data-session="1,0,0" data-layout="late"><time[^>]+>9:45 PM/);
  assert.match(main(imax), /href="https:\/\/example.test\/ticket\?one=1&amp;two=2"/);
  assert.match(imax, /<option value="date-2099-12-18">/);
  assert.match(main(imax), /id="date-2099-12-18"/);

  const sitemap = read(root, "sitemap.xml");
  const paths = ["cities/toronto/", "cities/toronto/imax/", "formats/4dx/"];
  for (const [index, pagePath] of paths.entries()) {
    const html = [toronto, imax, fourDx][index];
    assert.ok(html.includes(`<link rel="canonical" href="${SITE}${pagePath}" />`));
    assert.ok(html.includes(`<meta property="og:url" content="${SITE}${pagePath}"`));
    assert.ok(html.includes(`href="${pagePath}" aria-current="page"`));
    assert.ok(sitemap.includes(`<loc>${SITE}${pagePath}</loc>`));
    for (const source of ["index.html", "movies/index.html", "movies/shared-movie-and-friends/index.html", "theatres/big-screen/index.html"]) {
      assert.ok(read(root, source).includes(`href="${pagePath}"`), source);
    }
  }
  assert.equal((sitemap.match(/<loc>[^<]+\/(?:cities|formats)\//g) || []).length, 3);
});

test("empty and missing snapshots retain useful pilot routes and broader navigation", (t) => {
  const root = fixture(t);
  for (const file of ["big-screen", "petit-ecran"]) rmSync(path.join(root, `data/${file}.json`));
  assert.equal(run(root, "out").status, 0);
  for (const route of ["cities/toronto/", "cities/toronto/imax/", "formats/4dx/"]) {
    const page = read(root, `${route}index.html`);
    assert.match(page, /No matching showtimes in this snapshot/);
    assert.match(page, /does not mean a theatre is closed/);
    assert.match(page, /0 movies · 0 theatres · 0 dates/);
    assert.match(page, /href="movies\/">Browse all movies/);
    assert.match(page, /href="\.\/">check a theatre calendar/);
    assert.doesNotMatch(page, /<details class="landing-day"/);
    assert.ok(read(root, "sitemap.xml").includes(`<loc>${SITE}${route}</loc>`));
  }
});

test("landing-page date cutoff follows Toronto midnight, even when the host uses UTC", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "data/big-screen.json"), JSON.stringify({ days: [
    { date: "2030-05-30", movies: [{title: "Too Old", sessions: [{ time: "19:00", formats: ["IMAX"] }]}] },
    { date: "2030-05-31", movies: [{title: "Toronto Today", sessions: [{ time: "00:01", formats: ["IMAX"] }]}] },
    { date: "2030-06-01", movies: [{title: "Tomorrow", sessions: [{ time: "19:00", formats: ["IMAX"] }]}] },
  ] }));
  const clock = path.join(root, "clock.mjs");
  for (const [instant, includesMay31] of [["2030-06-01T03:59:00Z", true], ["2030-06-01T04:01:00Z", false]]) {
    writeFileSync(clock, `const OriginalDate = Date; globalThis.Date = class extends OriginalDate {
      constructor(...args) { super(...(args.length ? args : [${JSON.stringify(instant)}])); }
    };`);
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(clock).href, script, "out"], { cwd: root, encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
    assert.equal(result.status, 0, result.stderr);
    const page = read(root, "cities/toronto/imax/index.html");
    assert.equal(page.includes("Toronto Today"), includesMay31, instant);
    assert.ok(page.includes("Tomorrow"));
    assert.ok(!page.includes("Too Old"));
  }
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
