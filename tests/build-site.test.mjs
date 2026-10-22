import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));
const script = path.join(repo, "scripts/build-site.mjs");
const SITE = "https://ariesyous.github.io/cinescan/";
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

// Builds against the real index.html/app.js/style.css so template drift fails here first.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cinescan-site-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ["index.html", "app.js", "style.css", "assets"]) {
    cpSync(path.join(repo, entry), path.join(root, entry), { recursive: true });
  }
  mkdirSync(path.join(root, "data"));
  writeFileSync(path.join(root, "data/theatres.json"), JSON.stringify([
    { id: 1, slug: "big-screen", name: "Big Screen & VIP", city: "Toronto", province: "ON", metro: "GTA", file: "data/big-screen.json" },
    { id: 2, slug: "no-data", name: "No Data Cinema", city: "Regina", province: "SK", metro: null, file: "data/no-data.json" },
  ]));
  const movie = (title, formats) => ({ title, sessions: [{ time: "19:00", formats }] });
  writeFileSync(path.join(root, "data/big-screen.json"), JSON.stringify({
    updatedAt: "2026-10-07T00:00:00.000Z",
    days: [
      { date: "2000-01-01", movies: [movie("Gone Already", ["Regular"])] },
      { date: today, movies: [movie("Now Showing", ["IMAX", "Regular"])] },
      { date: "2099-12-18", movies: [movie("Advance <Sale>", ["UltraAVX"])] },
    ],
  }));
  return root;
}

test("builds theatre pages, home page and sitemap", (t) => {
  const root = fixture(t);
  const result = run(root, "out");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Built 2 theatre pages into out \(1 without data files\)/);

  const page = readFileSync(path.join(root, "out/theatres/big-screen/index.html"), "utf8");
  assert.match(page, /<title>Big Screen &amp; VIP Showtimes \| CineScan<\/title>/);
  assert.match(page, new RegExp(`<link rel="canonical" href="${SITE}theatres/big-screen/" />`));
  assert.match(page, /<base href="\.\.\/\.\.\/" \/>/);
  assert.match(page, /<meta name="cinescan-routing" content="path" \/>/);
  assert.match(page, /2 movies, including IMAX and UltraAVX screenings/);
  assert.match(page, /<h1 id="theatre-name">Showtimes at Big Screen &amp; VIP<\/h1>/);
  assert.match(page, /Now Showing<\/span> <span class="now-playing-formats">IMAX · Regular<\/span><\/li>/);
  assert.match(page, /Advance &lt;Sale&gt;<\/span>.*from /);
  assert.doesNotMatch(page, /Gone Already/);
  assert.match(page, /"addressRegion": "ON"/);
  assert.match(page, /<a href="theatres\/no-data\/">No Data Cinema<\/a>/);

  const bare = readFileSync(path.join(root, "out/theatres/no-data/index.html"), "utf8");
  assert.doesNotMatch(bare, /now-playing/);
  assert.match(bare, /<p class="loading">/);

  const home = readFileSync(path.join(root, "out/index.html"), "utf8");
  assert.match(home, /<base href="\.\/" \/>/);
  assert.match(home, new RegExp(`<link rel="canonical" href="${SITE}" />`));
  assert.match(home, /"@type": "WebSite"/);
  assert.match(home, /All 2 Cineplex theatres in Canada/);

  const sitemap = readFileSync(path.join(root, "out/sitemap.xml"), "utf8");
  assert.equal(sitemap.match(/<url>/g).length, 3);
  assert.match(sitemap, new RegExp(`<loc>${SITE}</loc><lastmod>2026-10-07T00:00:00.000Z</lastmod>`));
  assert.match(sitemap, new RegExp(`<loc>${SITE}theatres/no-data/</loc></url>`));

  for (const copied of ["app.js", "style.css", "assets/favicon.svg", "data/big-screen.json"]) {
    assert.ok(existsSync(path.join(root, "out", copied)), copied);
  }
});

test("fails when index.html no longer has a placeholder", (t) => {
  const root = fixture(t);
  const index = path.join(root, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace("<!--SITE_HEAD-->", ""));
  const result = run(root, "out");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SITE_HEAD/);
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
