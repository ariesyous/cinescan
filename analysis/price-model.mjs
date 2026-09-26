// Rough, editable price assumptions used only to turn ticket-volume
// estimates into a modeled $ figure. These are NOT Cineplex's real dynamic
// pricing -- actual prices vary by theatre, city, time of day (matinee vs.
// evening), day of week, age tier (adult/student/senior/child), and
// promotions ($5 Tuesdays, VIP Wednesdays, etc.) that this dataset has no
// way to see. Treat any revenue number this produces as an order-of-
// magnitude model, not a reported figure. See analysis/README.md.
//
// Base adult-evening list prices by primary experience type, and per-ticket
// modifier surcharges, ballparked from public reporting as of Sept 2026.
// Edit freely -- these are the one place to plug in better numbers.
export const BASE_PRICE_BY_FORMAT = {
  Regular: 14.99,
  "Laser Projection": 15.99,
  UltraAVX: 18.99,
  IMAX: 21.99,
  ScreenX: 19.99,
  "4DX": 24.99,
  VIP: 25.99,
};
export const DEFAULT_BASE_PRICE = 14.99;

// Applied once per ticket when the tag is present in a session's formats,
// on top of the base price above (not per D-BOX seat -- see dboxSurcharge
// below for the seat-level case).
export const MODIFIER_SURCHARGE = {
  "3D": 3.0,
};

// D-BOX is a seat-level premium (only the D-BOX-type seats in a room cost
// more), not a whole-session surcharge, so it's applied per sold D-BOX seat
// rather than through MODIFIER_SURCHARGE.
export const DBOX_SEAT_SURCHARGE = 8.0;

// Real experienceTypes tags include things this priority list doesn't
// price separately -- Recliner, Dolby Atmos, 70mm, Clubhouse, Early
// Access, Stars & Strollers (see analysis/README.md for the full observed
// list). Those aren't known premium-priced tiers as far as public pricing
// shows, so they're deliberately left unpriced here: a session carrying
// only one of them alongside "Regular" is priced as Regular. Cineplex's
// VIP tag is age-gated ("VIP 19+"/"VIP 18+"), not a bare "VIP" string, so
// it's matched by prefix instead of exact match.
const PRIMARY_FORMAT_PRIORITY = ["4DX", "IMAX", "UltraAVX", "ScreenX", "Laser Projection", "Regular"];

export function primaryFormat(formatsList) {
  if (formatsList.some((f) => f.startsWith("VIP"))) return "VIP";
  return PRIMARY_FORMAT_PRIORITY.find((f) => formatsList.includes(f)) || "Regular";
}

export function basePriceForFormats(formatsList) {
  const primary = primaryFormat(formatsList);
  const base = BASE_PRICE_BY_FORMAT[primary] ?? DEFAULT_BASE_PRICE;
  const modifierTotal = formatsList.reduce((sum, tag) => sum + (MODIFIER_SURCHARGE[tag] || 0), 0);
  return base + modifierTotal;
}
