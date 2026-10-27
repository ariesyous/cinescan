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
  for (const entry of ["index.html", "app.js", "movie.js", "style.css", "assets"]) {
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
  assert.match(page, /href="movies\/now-showing\/">Now Showing<\/a>/);
  assert.match(page, new RegExp(`<time datetime="${today}T19:00">7:00 PM</time>`));
  assert.match(page, /href="movies\/advance-sale\/">Advance &lt;Sale&gt;<\/a>/);
  assert.doesNotMatch(page, /Gone Already/);
  assert.match(page, /"addressRegion": "ON"/);
  assert.match(page, /<a href="theatres\/no-data\/">No Data Cinema<\/a>/);
  assert.match(page, /<span class="brand-nav"> &middot; <a href="movies\/">Browse movies<\/a><\/span>/);

  const bare = read(root, "theatres/no-data/index.html");
  assert.doesNotMatch(bare, /now-playing/);
  assert.match(bare, /No showtime snapshot is available/);
  assert.doesNotMatch(bare, /Loading showtimes/);

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

  for (const copied of ["app.js", "movie.js", "style.css", "assets/favicon.svg", "data/big-screen.json"]) {
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


const calendar = (html) => html.match(/<main id="calendar"[\s\S]*?<\/main>/)[0];

test("initial HTML contains ordered dates, local times, per-session formats and usable links", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "data/big-screen.json"), JSON.stringify({
    updatedAt: "2020-01-02T01:30:00Z",
    days: [
      { date: "2099-12-18", movies: [{ title: "Advance", sessions: [{ time: "00:15", formats: ["UltraAVX"] }] }] },
      { date: "2000-01-01", movies: [{ title: "Expired", sessions: [{ time: "23:59", formats: ["IMAX"] }] }] },
      { date: today, movies: [
        { title: 'Movie <One> & "Friends"', sessions: [
          { time: "21:45", formats: ["IMAX", "3D"], ticketUrl: "https://example.test/tickets?a=1&b=2", seats: ["AA"], layoutKey: "123" },
          { time: "12:00", formats: ["Regular"] },
          { time: "10:05", formats: ["Laser Projection", "D-BOX"] },
        ] },
        { title: "No Sessions", sessions: [] },
      ] },
      { date: "2099-12-19", movies: [] },
    ],
  }));
  const result = run(root, "out");
  assert.equal(result.status, 0, result.stderr);
  const page = read(root, "theatres/big-screen/index.html");
  const html = calendar(page);
  assert.match(html, /data-snapshot-theatre="big-screen"/);
  assert.match(html, /Movie &lt;One&gt; &amp; &quot;Friends&quot;/);
  assert.match(html, /href="movies\/movie-one-and-friends\/"/);
  assert.match(html, /href="https:\/\/example.test\/tickets\?a=1&amp;b=2" target="_blank" rel="noopener"/);
  for (const [time, label] of [["10:05", "10:05 AM"], ["12:00", "12:00 PM"], ["21:45", "9:45 PM"]]) {
    assert.ok(html.includes(`<time datetime="${today}T${time}">${label}</time>`));
  }
  assert.match(html, /<span class="session"><time datetime="2099-12-18T00:15">12:15 AM<\/time><\/span>/);
  assert.ok(html.indexOf("T10:05") < html.indexOf("T12:00"));
  assert.ok(html.indexOf("T12:00") < html.indexOf("T21:45"));
  assert.ok(html.indexOf("T21:45") < html.indexOf("2099-12-18"));
  assert.match(html, /9:45 PM<\/time><\/a><span class="format-badges"><span class="format-badge tag-imax">IMAX<\/span><span class="format-badge tag-3d">3D/);
  assert.match(html, /tag-laser-projection">Laser Projection/);
  assert.match(html, /tag-d-box">D-BOX/);
  assert.doesNotMatch(html, /Expired|No Sessions|2099-12-19|Loading|has-seats|hidden|now-playing/);
  assert.match(page, /Snapshot last updated Jan 1, 2020, 8:30 PM EST/);
  assert.match(page, /Times are local to the theatre/);
  assert.match(page, /some dates may be retained from earlier snapshots/);
  assert.match(page, /Confirm showtimes and current seat availability with Cineplex/);
  assert.match(page, /<script src="app.js"><\/script>/);
  assert.doesNotMatch(read(root, "sitemap.xml"), /\/(?:cities|formats)\//);
});

test("missing, empty, expired and undated snapshots have honest fallback and freshness text", (t) => {
  const root = fixture(t);
  for (const [data, message] of [
    [null, "No showtime snapshot is available"],
    [{ days: [], updatedAt: "2020-01-01T00:00:00Z" }, "No current or upcoming showtimes"],
    [{ days: [{ date: "2000-01-01", movies: [{ title: "Expired", sessions: [{ time: "19:00", formats: [] }] }] }] }, "No current or upcoming showtimes"],
    [{ days: [], updatedAt: "invalid" }, "No current or upcoming showtimes"],
  ]) {
    const file = path.join(root, "data/big-screen.json");
    if (data) writeFileSync(file, JSON.stringify(data));
    else rmSync(file);
    const result = run(root, "out");
    assert.equal(result.status, 0, result.stderr);
    const page = read(root, "theatres/big-screen/index.html");
    assert.ok(calendar(page).includes(message));
    assert.match(calendar(page), /does not mean the theatre is closed/);
    assert.match(calendar(page), /href="movies\/"/);
    assert.doesNotMatch(calendar(page), /class="day-card"|Expired|Loading/);
    assert.match(page, data === null ? /Showtime snapshot unavailable/ : data.updatedAt === "2020-01-01T00:00:00Z" ? /Snapshot last updated Dec 31, 2019/ : /Snapshot update time unavailable/);
    assert.doesNotMatch(page, /Invalid Date/);
  }
});

test("theatre cutoff follows Toronto midnight in summer and winter regardless of host timezone", (t) => {
  const root = fixture(t);
  const clock = path.join(root, "clock.mjs");
  for (const [date, before, after] of [
    ["2030-05-31", "2030-06-01T03:59:00Z", "2030-06-01T04:01:00Z"],
    ["2030-01-31", "2030-02-01T04:59:00Z", "2030-02-01T05:01:00Z"],
  ]) {
    writeFileSync(path.join(root, "data/big-screen.json"), JSON.stringify({ days: [
      { date, movies: [{ title: "Toronto Today", sessions: [{ time: "00:01", formats: ["Regular"] }] }] },
      { date: "2099-01-01", movies: [{ title: "Future", sessions: [{ time: "19:00", formats: ["Regular"] }] }] },
    ] }));
    for (const [instant, included] of [[before, true], [after, false]]) {
      writeFileSync(clock, `const OriginalDate = Date; globalThis.Date = class extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : [${JSON.stringify(instant)}])); }
      };`);
      const result = spawnSync(process.execPath, ["--import", pathToFileURL(clock).href, script, "out"], {
        cwd: root, encoding: "utf8", env: { ...process.env, TZ: "Asia/Tokyo" },
      });
      assert.equal(result.status, 0, result.stderr);
      const html = calendar(read(root, "theatres/big-screen/index.html"));
      assert.equal(html.includes("Toronto Today"), included, instant);
      assert.ok(html.includes("Future"));
    }
  }
});
