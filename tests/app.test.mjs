import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

// Minimal DOM/event double for the real app.js. No frontend build or browser
// dependency is required; visual/layout checks still need a real browser.
class Element {
  children = [];
  dataset = {};
  style = {};
  listeners = {};
  className = "";
  textContent = "";
  value = "";
  hidden = false;
  _html = "";
  classList = {
    add: (name) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
    remove: (name) => { this.className = this.className.split(" ").filter((x) => x !== name).join(" "); },
    contains: (name) => this.className.split(" ").includes(name),
    toggle: (name, on) => on ? this.classList.add(name) : this.classList.remove(name),
  };
  constructor(tag = "div") { this.tagName = tag; }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.innerHTML = ""; this.append(...children); }
  remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  fire(name, event = {}) { return this.listeners[name]?.(event); }
  setAttribute(name, value) { this[name] = value; }
  contains(el) { return this === el || this.children.some((child) => child.contains(el)); }
  matches(selector) { return selector === "[data-date]" ? Boolean(this.dataset.date) : this.classList.contains(selector.slice(1)); }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { top: 100, bottom: 140, left: 20, width: 300, height: 180 }; }
  focus() {}
  blur() {}
}
const theatres = [
  { id: 7402, slug: "first", name: "First Theatre", city: "Toronto", province: "ON", metro: "GTA", file: "data/first.json" },
  { id: 2, slug: "second", name: "Second Theatre", city: "Toronto", province: "ON", metro: "GTA", file: "data/second.json" },
];
const today = "2030-06-01";
const snapshot = (title = "Current Movie", updatedAt = "2030-06-01T10:00:00Z") => ({
  updatedAt,
  auditoriums: { "123": { totalColumns: 3, seatTypes: ["SWD"] } },
  days: [
    { date: "2030-05-31", movies: [{ title: "Expired", sessions: [{ time: "19:00", formats: ["Regular"] }] }] },
    { date: today, movies: [{ title, sessions: [
      { time: "19:00", formats: ["IMAX", "3D"], ticketUrl: "https://example.test/tickets", layoutKey: "123", seats: ["AAO"] },
      { time: "20:00", formats: ["Regular"] },
    ] }] },
  ],
});
const flush = () => new Promise(setImmediate);

function harness({ generated = true, hover = true, formats = "", expired = false } = {}) {
  const elements = new Map();
  const get = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const calendar = get("calendar");
  if (generated) {
    calendar.dataset.snapshotTheatre = "first";
    calendar.innerHTML = "Generated showtimes";
    const card = new Element("section");
    card.dataset.date = expired ? "2030-05-31" : today;
    calendar.appendChild(card);
    get("updated").textContent = "Original snapshot timestamp";
  }
  const document = new Element();
  document.body = new Element();
  document.documentElement = { clientWidth: 390 };
  document.getElementById = get;
  document.createElement = (tag) => new Element(tag);
  document.createTextNode = (text) => Object.assign(new Element("text"), { textContent: text });
  document.querySelector = () => generated ? { content: "path" } : null;
  document.baseURI = "https://example.test/";
  document.title = generated ? "First Theatre Showtimes | CineScan" : "CineScan";
  const window = new Element();
  Object.assign(window, { matchMedia: () => ({ matches: hover }), innerHeight: 844, innerWidth: 390, scrollY: 0, scrollX: 0 });
  const location = new URL(`https://example.test/${generated ? "theatres/first/" : ""}${formats ? `?formats=${formats}` : ""}`);
  const requests = [];
  const context = vm.createContext({
    document, window, location, URL, URLSearchParams,
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : ["2030-06-01T12:00:00Z"])); } },
    history: { pushState: (_, __, url) => { location.href = url; }, replaceState: (_, __, url) => { location.href = url; } },
    fetch: (file) => new Promise((resolve, reject) => requests.push({ file, resolve, reject })),
  });
  vm.runInContext(readFileSync(new URL("../app.js", import.meta.url), "utf8"), context);
  const respond = async (i, data, ok = true) => {
    requests[i].resolve({ ok, status: ok ? 200 : 503, json: async () => data });
    await flush();
  };
  return { get, calendar, document, window, location, requests, respond, context };
}

test("generated content survives slow/failed enhancement and is replaced once on success", async () => {
  const h = harness();
  assert.equal(h.calendar.innerHTML, "Generated showtimes");
  await h.respond(0, theatres);
  assert.equal(h.calendar.innerHTML, "Generated showtimes");
  await h.respond(1, null, false);
  assert.equal(h.calendar.innerHTML, "Generated showtimes");
  assert.equal(h.get("updated").textContent, "Original snapshot timestamp");
  assert.match(h.calendar.querySelector(".error").textContent, /interactive calendar/);
  h.window.fire("popstate");
  await h.respond(2, snapshot());
  assert.equal(h.calendar.dataset.snapshotTheatre, undefined);
  assert.equal(h.calendar.innerHTML, "");
  assert.equal(h.calendar.querySelectorAll(".day-card").length, 1);
  assert.equal(h.calendar.querySelectorAll(".session").length, 2);
  assert.equal(h.calendar.querySelector(".error"), null);
  assert.equal(h.calendar.querySelector(".movie-title").children[0].textContent, "Current Movie");
  assert.match(h.get("updated").textContent, /Snapshot last updated/);
});

test("manifest failures retain the answer and cached generated dates are pruned at Toronto midnight", async () => {
  const h = harness();
  await h.respond(0, null, false);
  assert.equal(h.calendar.innerHTML, "Generated showtimes");
  assert.match(h.calendar.querySelector(".error").textContent, /Couldn't load theatres/);
  const old = harness({ expired: true });
  await old.respond(0, null, false);
  assert.equal(old.calendar.querySelectorAll("[data-date]").length, 0);
  assert.match(old.calendar.innerHTML, /No current or upcoming showtimes/);
});

test("switching theatres clears old content and seats; late responses cannot overwrite the selection", async () => {
  const h = harness();
  await h.respond(0, theatres);
  // The first snapshot request is still pending when the user switches.
  h.get("theatre-list").children.find((el) => el.textContent === "Second Theatre").fire("click");
  assert.equal(h.calendar.dataset.snapshotTheatre, undefined);
  assert.match(h.calendar.innerHTML, /Loading/);
  assert.equal(h.location.pathname, "/theatres/second/");
  await h.respond(2, snapshot("Second Movie", undefined));
  await h.respond(1, snapshot("Wrong Movie"));
  assert.equal(h.calendar.querySelector(".movie-title").children[0].textContent, "Second Movie");
  assert.equal(h.get("theatre-name").textContent, "Showtimes at Second Theatre");
  h.calendar.querySelector(".has-seats").fire("mouseenter");
  assert.equal(h.document.body.querySelector(".seat-popover").hidden, false);
  h.get("theatre-list").children.find((el) => el.textContent === "First Theatre").fire("click");
  assert.equal(h.document.body.querySelector(".seat-popover").hidden, true);
  await h.respond(3, { ...snapshot(), updatedAt: null });
  assert.equal(h.get("updated").textContent, "Snapshot update time unavailable.");
  h.calendar.querySelector(".has-seats").fire("focus");
  assert.equal(h.document.body.querySelector(".seat-caption"), null);
});

test("format filters, generated movie links and touch-first seat previews remain usable", async () => {
  const h = harness({ formats: "IMAX", hover: false });
  await h.respond(0, theatres);
  await h.respond(1, snapshot());
  assert.equal(h.calendar.querySelectorAll(".session").length, 1);
  assert.equal(h.calendar.querySelector(".movie-title").children[0].href, "movies/current-movie/");
  const chip = h.calendar.querySelector(".has-seats");
  let prevented = false;
  chip.fire("click", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.document.body.querySelector(".seat-popover").hidden, false);
  assert.equal(h.document.body.querySelectorAll(".seat").length, 3);
  prevented = false;
  chip.fire("click", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(chip.href, "https://example.test/tickets");
  h.get("format-filter").querySelector(".format-clear-btn").fire("click");
  assert.equal(h.calendar.querySelectorAll(".session").length, 0);
  h.get("format-filter").querySelector(".format-clear-btn").fire("click");
  assert.equal(h.calendar.querySelectorAll(".session").length, 2);
  assert.equal(h.location.search, "");
});

test("raw checkout retains query-string routing and needs no generated pages", async () => {
  const h = harness({ generated: false });
  await h.respond(0, theatres);
  await h.respond(1, snapshot());
  assert.equal(h.location.pathname, "/");
  assert.equal(h.calendar.querySelector(".movie-title").textContent, "Current Movie");
  assert.equal(h.calendar.querySelector(".movie-title").children.length, 0);
  // Use the same real picker action as a user searching for another theatre.
  h.get("theatre-search").value = "Second";
  h.get("theatre-search").fire("input");
  const group = h.get("theatre-dropdown").children[0];
  group.children.find((el) => el.tagName === "button").fire("click");
  await h.respond(2, snapshot("Second Movie"));
  assert.equal(h.location.search, "?theatre=second");
});
