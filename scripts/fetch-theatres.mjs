// Fetches the full list of Cineplex theatres across Canada and writes
// data/theatres.json. This is a maintenance script, not part of the daily
// scrape — the theatre list rarely changes, so re-run it manually when a
// theatre opens/closes.

const SUBSCRIPTION_KEY = process.env.CINEPLEX_SUBSCRIPTION_KEY;
if (!SUBSCRIPTION_KEY) {
  throw new Error("CINEPLEX_SUBSCRIPTION_KEY is required");
}
const API_BASE = "https://apis.cineplex.com/prod/cpx/theatrical/api/v1";
const THEATRES_PATH = new URL("../data/theatres.json", import.meta.url);

async function fetchTheatres() {
  const url = `${API_BASE}/theatres?language=en`;
  const res = await fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching theatre list`);
  return res.json();
}

function slugFromTheatreUrl(theatreUrl, theatreId) {
  return theatreUrl ? theatreUrl.toLowerCase() : `theatre-${theatreId}`;
}

// Buckets a theatre's city into one of the frontend's big metro-area
// buttons (see app.js region nav). Hand-maintained since Cineplex's API
// gives us a city name, not a metro-area id, and the theatre list is
// static enough that this doesn't need to be automatic.
const METRO_CITIES = {
  GTA: new Set([
    "Toronto",
    "Mississauga",
    "Oakville",
    "Vaughan",
    "Markham",
    "Milton",
    "Brampton",
    "Burlington",
    "Ajax",
    "Aurora",
    "Richmond Hill",
    "East Gwillimbury",
    "Pickering",
    "Oshawa",
    "Clarington",
  ]),
  Montreal: new Set([
    "Montréal",
    "Laval",
    "Brossard",
    "Kirkland",
    "Vaudreuil-Dorion",
    "Saint-Bruno-de-Montarville",
    "Mont-Royal",
  ]),
  Vancouver: new Set([
    "Vancouver",
    "Burnaby",
    "Coquitlam",
    "Surrey",
    "Langley",
    "Richmond",
    "West Vancouver",
    "Pitt Meadows",
    "Mission",
    "Abbotsford",
  ]),
};

function metroForCity(city) {
  if (!city) return null;
  for (const [metro, cities] of Object.entries(METRO_CITIES)) {
    if (cities.has(city)) return metro;
  }
  return null;
}

async function main() {
  const { writeFile } = await import("node:fs/promises");
  const payload = await fetchTheatres();

  const byId = new Map();
  for (const t of [
    ...(payload.favouriteTheatres ?? []),
    ...(payload.nearbyTheatres ?? []),
    ...(payload.otherTheatres ?? []),
  ]) {
    if (!byId.has(t.theatreId)) byId.set(t.theatreId, t);
  }

  const theatres = [...byId.values()]
    .map((t) => {
      const slug = slugFromTheatreUrl(t.theatreUrl, t.theatreId);
      const city = t.location?.city ?? null;
      return {
        id: t.theatreId,
        slug,
        name: t.theatreName,
        city,
        province: t.location?.provinceCode ?? null,
        metro: metroForCity(city),
        file: `data/${slug}.json`,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  await writeFile(THEATRES_PATH, JSON.stringify(theatres, null, 2) + "\n");
  console.log(`Wrote ${theatres.length} theatres to data/theatres.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
