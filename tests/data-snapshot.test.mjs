import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../scripts/data-snapshot.mjs", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const run = (cwd, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const snapshot = (id, seats = "AAO") => ({
  updatedAt: "2026-10-07T00:00:00Z", theatre: { id }, auditoriums: {},
  days: [{ date: "2027-01-01", movies: [{ title: "Advance sale", sessions: [{ seats: [seats] }] }] }],
});
function write(cwd, file, value) {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), JSON.stringify(value));
}
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "cinescan-storage-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git");
  const repo = path.join(root, "repo");
  git(root, "init", "--bare", remote);
  git(root, "init", "-b", "master", repo);
  git(repo, "config", "user.name", "Storage test");
  git(repo, "config", "user.email", "storage@example.test");
  git(repo, "remote", "add", "origin", remote);
  write(repo, "data/theatres.json", [{ id: 1, file: "data/one.json" }, { id: 2, file: "data/two.json" }]);
  writeFileSync(path.join(repo, ".gitignore"), "data/*.json\n!data/theatres.json\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "Source only");
  git(repo, "push", "origin", "master");
  write(repo, "data/one.json", snapshot(1));
  write(repo, "data/two.json", snapshot(2));
  return { root, remote, repo };
}
function seed(repo) {
  const result = run(repo, "publish", "");
  assert.equal(result.status, 0, result.stderr);
  const restored = run(repo, "restore");
  assert.equal(restored.status, 0, restored.stderr);
  return restored.stdout.trim();
}

test("replacement has one commit and contains only current theatre data", t => {
  const { repo, remote } = fixture(t);
  const head = git(repo, "rev-parse", "HEAD");
  const index = git(repo, "write-tree");
  const first = seed(repo);
  write(repo, "data/one.json", snapshot(1, "OOO"));
  write(repo, "data/obsolete.json", snapshot(99));
  const result = run(repo, "publish", first);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(remote, "rev-list", "--count", "data"), "1");
  assert.equal(git(remote, "ls-tree", "-r", "--name-only", "data"), "data/one.json\ndata/two.json");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "write-tree"), index);
});

test("restoration preserves manifest, failed-theatre data and advance-sale days", t => {
  const { repo } = fixture(t);
  const first = seed(repo);
  const manifest = readFileSync(path.join(repo, "data/theatres.json"), "utf8");
  const failedTheatre = readFileSync(path.join(repo, "data/two.json"), "utf8");
  write(repo, "data/one.json", snapshot(1, "OOO")); // one theatre succeeds, the other stays untouched
  assert.equal(run(repo, "publish", first).status, 0);
  rmSync(path.join(repo, "data/one.json"));
  rmSync(path.join(repo, "data/two.json"));
  write(repo, "data/obsolete.json", snapshot(99));
  assert.equal(run(repo, "restore").status, 0);
  assert.equal(readFileSync(path.join(repo, "data/theatres.json"), "utf8"), manifest);
  assert.equal(readFileSync(path.join(repo, "data/two.json"), "utf8"), failedTheatre);
  assert.equal(JSON.parse(readFileSync(path.join(repo, "data/one.json"))).days[0].date, "2027-01-01");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.throws(() => readFileSync(path.join(repo, "data/obsolete.json")), { code: "ENOENT" });
});

test("unchanged data does not create a new snapshot", t => {
  const { repo, remote } = fixture(t);
  const first = seed(repo);
  const result = run(repo, "publish", first);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No data changes/);
  assert.equal(git(remote, "rev-parse", "data"), first);
});

test("stale publisher and repeated bootstrap cannot overwrite newer data", t => {
  const { repo, remote } = fixture(t);
  const first = seed(repo);
  write(repo, "data/one.json", snapshot(1, "OOO"));
  assert.equal(run(repo, "publish", first).status, 0);
  const second = git(remote, "rev-parse", "data");
  write(repo, "data/one.json", snapshot(1, "AAA"));
  const stale = run(repo, "publish", first);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale info|rejected/);
  assert.notEqual(run(repo, "publish", "").status, 0);
  assert.equal(git(remote, "rev-parse", "data"), second);
});

test("restore failures preserve local files and do not silently bootstrap", t => {
  const { repo } = fixture(t);
  const before = readFileSync(path.join(repo, "data/one.json"), "utf8");
  assert.notEqual(run(repo, "restore").status, 0); // data branch missing
  assert.equal(readFileSync(path.join(repo, "data/one.json"), "utf8"), before);
  git(repo, "remote", "set-url", "origin", path.join(repo, "missing-remote"));
  assert.notEqual(run(repo, "restore", git(repo, "rev-parse", "HEAD")).status, 0);
  assert.equal(readFileSync(path.join(repo, "data/one.json"), "utf8"), before);
});

test("first migration restores pinned source data and publishes without a parent", t => {
  const { repo, remote } = fixture(t);
  git(repo, "add", "-f", "data/one.json", "data/two.json");
  git(repo, "commit", "-m", "Pre-migration snapshot");
  const bootstrap = git(repo, "rev-parse", "HEAD");
  git(repo, "push", "origin", "master");
  git(repo, "rm", "--cached", "data/one.json", "data/two.json");
  git(repo, "commit", "-m", "Remove data from source");
  write(repo, "data/one.json", snapshot(1, "OOO"));
  const restored = run(repo, "restore", bootstrap);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(restored.stdout.trim(), "");
  assert.equal(JSON.parse(readFileSync(path.join(repo, "data/one.json"))).days[0].movies[0].sessions[0].seats[0], "AAO");
  assert.equal(run(repo, "publish", restored.stdout.trim()).status, 0);
  assert.equal(git(remote, "rev-list", "--count", "data"), "1");
  assert.equal(git(remote, "ls-tree", "-r", "--name-only", "data"), "data/one.json\ndata/two.json");
  // Once initialized, a bootstrap argument cannot replace the live branch.
  const first = run(repo, "restore", bootstrap).stdout.trim();
  write(repo, "data/one.json", snapshot(1, "OOO"));
  assert.equal(run(repo, "publish", first).status, 0);
  assert.equal(run(repo, "restore", bootstrap).status, 0);
  assert.equal(JSON.parse(readFileSync(path.join(repo, "data/one.json"))).days[0].movies[0].sessions[0].seats[0], "OOO");
});

test("invalid and empty local data are refused before publication", t => {
  const { repo, remote } = fixture(t);
  const first = seed(repo);
  write(repo, "data/one.json", snapshot(999));
  assert.notEqual(run(repo, "publish", first).status, 0);
  assert.equal(git(remote, "rev-parse", "data"), first);
  rmSync(path.join(repo, "data/one.json"));
  rmSync(path.join(repo, "data/two.json"));
  assert.notEqual(run(repo, "publish", first).status, 0);
  assert.equal(git(remote, "rev-parse", "data"), first);
});

test("unexpected remote contents are rejected before replacing local data", t => {
  const { repo, remote } = fixture(t);
  const first = seed(repo);
  // Force an invalid source-only tree onto the data ref to simulate corruption.
  const bad = git(repo, "commit-tree", git(repo, "write-tree"), "-m", "Invalid snapshot");
  git(repo, "push", `--force-with-lease=refs/heads/data:${first}`, "origin", `${bad}:refs/heads/data`);
  const before = readFileSync(path.join(repo, "data/one.json"), "utf8");
  assert.notEqual(run(repo, "restore").status, 0);
  assert.equal(readFileSync(path.join(repo, "data/one.json"), "utf8"), before);
  assert.equal(git(remote, "rev-parse", "data"), bad);
});
