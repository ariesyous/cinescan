// The data branch is a replaceable snapshot, never a growing commit chain.
// Run from the repository root. Requires Git and Node, but no API credentials.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATA_REF = "refs/heads/data";
const FILE_PATTERN = /^data\/(?!theatres\.json$)[a-z0-9-]+\.json$/;
const git = (args, options = {}) => execFileSync("git", args, {
  encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options,
});

function validate(file, text, expectedId) {
  const data = JSON.parse(text);
  if (!data.theatre?.id || !Array.isArray(data.days) ||
      !data.updatedAt || !Number.isFinite(Date.parse(data.updatedAt)) ||
      (expectedId !== undefined && data.theatre.id !== expectedId)) {
    throw new Error(`Invalid theatre snapshot: ${file}`);
  }
}

function restore(bootstrap) {
  if (bootstrap !== undefined && !/^[a-f0-9]{40}$/.test(bootstrap)) {
    throw new Error("Bootstrap snapshot must be an immutable commit SHA");
  }
  let initializing = false;
  try {
    // Exit 2 means the ref is absent. Network/authentication errors have a
    // different status and must never be mistaken for the first migration.
    git(["ls-remote", "--exit-code", "origin", DATA_REF]);
  } catch (error) {
    if (error.status !== 2 || !bootstrap) throw error;
    initializing = true;
    console.error(`Initializing from known-good source snapshot ${bootstrap}`);
  }
  git(["fetch", "--no-tags", "--depth=1", "origin", initializing ? bootstrap : DATA_REF], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  const sha = git(["rev-parse", "FETCH_HEAD"]).trim();
  const entries = git(["ls-tree", "-r", sha, ...(initializing ? ["--", "data"] : [])]).trim().split("\n");
  const staging = mkdtempSync(path.join(tmpdir(), "cinescan-restore-"));
  try {
    for (const entry of entries) {
      const [metadata, file] = entry.split("\t");
      if (initializing && file === "data/theatres.json") continue;
      if (!FILE_PATTERN.test(file ?? "") || !metadata.startsWith("100644 blob ")) {
        throw new Error(`Unexpected file in data snapshot: ${entry}`);
      }
      const text = git(["show", `${sha}:${file}`]);
      validate(file, text);
      mkdirSync(path.join(staging, "data"), { recursive: true });
      writeFileSync(path.join(staging, file), text);
    }
    if (!existsSync(path.join(staging, "data"))) throw new Error("Empty bootstrap snapshot");
    // Validate the complete snapshot before touching existing local data.
    mkdirSync("data", { recursive: true });
    for (const file of readdirSync("data")) {
      if (FILE_PATTERN.test(`data/${file}`)) rmSync(path.join("data", file));
    }
    cpSync(path.join(staging, "data"), "data", { recursive: true });
    // An empty lease is safe only after we proved that the branch is absent.
    console.log(initializing ? "" : sha);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function publish(previous) {
  // An explicitly empty lease is only for the one-time branch bootstrap.
  if (previous === undefined || (previous !== "" && !/^[a-f0-9]{40}$/.test(previous))) {
    throw new Error("publish requires the SHA returned by restore (or an explicit empty bootstrap lease)");
  }
  const manifest = JSON.parse(readFileSync("data/theatres.json", "utf8"));
  const files = [];
  for (const theatre of manifest) {
    if (!FILE_PATTERN.test(theatre.file)) throw new Error(`Invalid manifest path: ${theatre.file}`);
    // A newly added theatre may have no successful scrape yet. Keep the
    // existing fail-soft behavior; other theatres can still be published.
    if (!existsSync(theatre.file)) continue;
    validate(theatre.file, readFileSync(theatre.file, "utf8"), theatre.id);
    files.push(theatre.file);
  }
  if (!files.length) throw new Error("Refusing to publish an empty data snapshot");
  const staging = mkdtempSync(path.join(tmpdir(), "cinescan-publish-"));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(staging, "index") };
  try {
    // Separate index: only current manifest theatre files, no source files,
    // manifest, obsolete theatres or parent commits enter the data branch.
    git(["read-tree", "--empty"], { env });
    git(["add", "-f", "--", ...files], { env });
    const tree = git(["write-tree"], { env }).trim();
    if (previous && tree === git(["rev-parse", `${previous}^{tree}`]).trim()) {
      console.log("No data changes");
      return;
    }
    const commit = git(["commit-tree", tree, "-m", "Update showtimes"], { env }).trim();
    git(["push", `--force-with-lease=${DATA_REF}:${previous}`, "origin", `${commit}:${DATA_REF}`], {
      stdio: "inherit",
    });
    console.log(`Published ${files.length} theatre files in snapshot ${commit}`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

try {
  const [command, previous] = process.argv.slice(2);
  if (command === "restore") restore(previous);
  else if (command === "publish") publish(previous);
  else throw new Error("Usage: node scripts/data-snapshot.mjs restore [bootstrap-sha] | publish <previous-sha>");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
