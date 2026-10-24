import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

// A small event/DOM double lets us exercise touch and network races without
// requiring a browser framework or changing the production build.
class Element {
  listeners = new Map();
  attributes = {};
  children = [];
  style = {};
  dataset = {};
  classes = new Set();
  classList = {
    add: (name) => this.classes.add(name),
    remove: (name) => this.classes.delete(name),
    contains: (name) => this.classes.has(name),
  };
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  fire(name, event = {}) { return this.listeners.get(name)?.(event); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  appendChild(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  contains(el) { return el === this; }
  getBoundingClientRect() { return { left: 20, top: 100, bottom: 144, width: 288, height: 180 }; }
  querySelector() { return { getAttribute: () => "2030-06-01T19:00" }; }
}
const flush = () => new Promise(setImmediate);
const snapshot = () => ({
  updatedAt: "2030-06-01T10:00:00Z",
  days: [{ date: "2030-06-01", movies: [{ sessions: [{ time: "19:00", layoutKey: "123", seats: ["AO"] }] }] }],
  auditoriums: { "123": { totalColumns: 2, seatTypes: ["SD"] } },
});

function harness({ hover = false } = {}) {
  const chips = [new Element(), new Element()];
  for (const chip of chips) chip.dataset = { file: "data/cinema.json", session: "0,0,0", layout: "123" };
  const popover = new Element();
  const document = new Element();
  document.body = new Element();
  document.documentElement = { clientWidth: 320 };
  document.createElement = () => popover;
  document.querySelectorAll = (selector) => selector.includes("has-seats") ? chips : [];
  document.getElementById = () => null;
  const window = new Element();
  Object.assign(window, { matchMedia: () => ({ matches: hover }), innerHeight: 740, scrollX: 0, scrollY: 0 });
  const requests = [];
  const rendered = [];
  vm.runInNewContext(readFileSync(new URL("../landing.js", import.meta.url), "utf8"), {
    document, window, location: { hash: "" }, URL,
    fetch: (file) => new Promise((resolve) => requests.push({ file, resolve })),
    renderSeatMap: (...args) => rendered.push(args),
  });
  const tap = (chip) => {
    let prevented = false;
    chip.fire("click", { preventDefault: () => { prevented = true; } });
    document.fire("click", { target: chip });
    return prevented;
  };
  return { chips, popover, document, requests, rendered, tap };
}

test("touch previews on first tap, follows tickets on second, and caches each theatre snapshot", async () => {
  const h = harness();
  assert.equal(h.requests.length, 0); // No eager snapshot fan-out.
  assert.equal(h.tap(h.chips[0]), true);
  assert.equal(h.chips[0].classList.contains("seat-preview-active"), true);
  h.requests[0].resolve({ ok: true, json: async () => snapshot() });
  await flush();
  assert.equal(h.rendered.length, 1);
  assert.deepEqual(h.rendered[0][1].seats, ["AO"]);
  assert.equal(h.tap(h.chips[0]), false);
  assert.equal(h.tap(h.chips[1]), true);
  await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.chips[0].attributes["aria-expanded"], "false");
  assert.equal(h.chips[1].attributes["aria-expanded"], "true");
  h.document.fire("keydown", { key: "Escape" });
  assert.equal(h.popover.hidden, true);
  assert.equal(h.chips[1].attributes["aria-expanded"], "false");
});

test("dismissed async previews stay closed and changed sessions never display another seat map", async () => {
  const h = harness({ hover: true });
  h.chips[0].fire("mouseenter");
  h.chips[0].fire("mouseleave");
  h.requests[0].resolve({ ok: true, json: async () => snapshot() });
  await flush();
  assert.equal(h.popover.hidden, true);
  assert.equal(h.rendered.length, 0);
  h.chips[1].dataset.layout = "a-different-session";
  await h.chips[1].fire("focus");
  assert.match(h.popover.textContent, /Seat map unavailable/);
  assert.equal(h.rendered.length, 0);
  h.document.fire("click", { target: new Element() });
  assert.equal(h.popover.hidden, true);
});

test("failed snapshot loads offer a fallback and can be retried", async () => {
  const h = harness();
  h.tap(h.chips[0]);
  h.requests[0].resolve({ ok: false });
  await flush();
  assert.match(h.popover.textContent, /Open the theatre calendar/);
  h.document.fire("keydown", { key: "Escape" });
  h.tap(h.chips[0]);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ ok: true, json: async () => snapshot() });
  await flush();
  assert.equal(h.rendered.length, 1);
});

test("shared renderer preserves standard, accessible and D-BOX seat states", () => {
  const context = { document: { createElement: () => new Element() } };
  vm.createContext(context);
  vm.runInContext(readFileSync(new URL("../seat-map.js", import.meta.url), "utf8"), context);
  const container = new Element();
  context.renderSeatMap(container, { seats: ["AAAO."] }, { totalColumns: 5, seatTypes: ["SWDDS"] }, "snapshot time");
  assert.deepEqual(container.children[0].children.map((el) => el.className), [
    "seat seat-available", "seat seat-available-accessible", "seat seat-available-dbox", "seat seat-occupied", "seat seat-none",
  ]);
  assert.equal(container.children[0].attributes["aria-label"], "Seat map: 3 available, 1 occupied");
  assert.match(container.children[1].innerHTML, /D-BOX/);
  assert.equal(container.children[2].textContent, "Seats as of snapshot time");
});
