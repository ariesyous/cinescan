// The seat map that previews a showtime, on the theatre page (app.js) and on
// movie pages (movie.js): hovering a time (or tapping it, on a touch screen)
// shows which seats are taken and roughly when the film ends.
//
// Pages load this before their own script. It touches nothing on the page
// until a map is first shown, so tests can load it on its own.
//
// SeatMap.attach(chip, load) gives a time its map. `load` is called when the
// map is wanted and returns the map, a promise of it, or null for none:
//
//   { layout, seats, time: "19:30", runtimeMinutes, asOf: "Nov 4, 2026, 5:03 PM EST" }
//
// `layout` is a theatre file's auditoriums[layoutKey] and `seats` the session's
// own seats (see "Seat data" in AGENTS.md).
const SeatMap = (() => {
  // A load quicker than this never says "Loading", so it doesn't flash.
  const LOADING_DELAY_MS = 150;

  let popover = null; // the one floating element, made when first needed
  let activeChip = null; // the time whose map is open (or loading)
  let request = 0; // numbers every show() and hide(), so a map that loads late can tell it's no longer wanted

  // "2:10 PM", for a "14:10" showtime. Same as formatTimeLabel in app.js and movie.js.
  function timeLabel(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  }

  // "2h 5m", for a runtime in minutes. Also in scripts/build-site.mjs, which
  // shows it on movie pages and can't share code with this file.
  function formatRuntime(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
  }

  // When a session ends if the film starts at its listed time, e.g. "12:45 AM"
  // ("" when the runtime isn't known). It can land after midnight.
  function endTimeLabel(timeStr, runtimeMinutes) {
    if (!runtimeMinutes) return "";
    const [h, m] = timeStr.split(":").map(Number);
    const end = (h * 60 + m + runtimeMinutes) % (24 * 60);
    return timeLabel(`${Math.floor(end / 60)}:${String(end % 60).padStart(2, "0")}`);
  }

  // The classes for one seat. `state` is the session's character for it (A
  // available, O occupied, anything else unknown or no seat) and `type` the
  // layout's (S standard, W wheelchair, C companion, D D-BOX).
  function seatClass(state, type) {
    if (state === "A") {
      if (type === "W" || type === "C") return "seat seat-available-accessible";
      return type === "D" ? "seat seat-available-dbox" : "seat seat-available";
    }
    return state === "O" ? "seat seat-occupied" : "seat seat-none";
  }

  // Whether the visitor has a pointer that can hover; touch screens don't.
  function canHover() {
    return window.matchMedia("(hover: hover)").matches;
  }

  function popoverEl() {
    if (!popover) {
      popover = document.createElement("div");
      popover.className = "seat-popover";
      popover.hidden = true;
      document.body.appendChild(popover);
      // A tap anywhere but the time it belongs to, or the map itself, closes it.
      document.addEventListener("click", (e) => {
        if (popover.hidden || popover.contains(e.target) || activeChip?.contains(e.target)) return;
        hide();
      });
    }
    return popover;
  }

  function hide() {
    request++; // anything still loading is no longer wanted
    activeChip = null;
    if (popover) popover.hidden = true;
  }

  // Shows the popover just under a time, or just above it when it wouldn't fit
  // below on screen (the pointer has to stay on the time, so there's no way to
  // scroll to the rest of it).
  function place(chip) {
    // The page redrew its times while the map loaded, so there's nothing left to put it by.
    if (!chip.isConnected) {
      hide();
      return;
    }
    // Measured at the corner, not wherever it was last: a popover near the right
    // edge would otherwise be squeezed to the room it had there.
    popover.style.left = "0";
    popover.style.top = "0";
    popover.hidden = false;

    const margin = 8;
    const gap = 6;
    const chipRect = chip.getBoundingClientRect();
    const popRect = popover.getBoundingClientRect();
    let left = chipRect.left + window.scrollX;
    let top = chipRect.bottom + window.scrollY + gap;
    if (
      chipRect.bottom + gap + popRect.height > window.innerHeight - margin &&
      chipRect.top - gap - popRect.height >= margin
    ) {
      top = chipRect.top + window.scrollY - gap - popRect.height;
    }
    const right = window.scrollX + document.documentElement.clientWidth - margin;
    if (left + popRect.width > right) left = right - popRect.width;
    if (left < window.scrollX + margin) left = window.scrollX + margin;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  // On touch the first tap opens the map instead of the ticket page, which
  // isn't obvious until someone's tapped twice.
  function touchHint(chip) {
    if (canHover() || !chip.href) return null;
    const hint = document.createElement("p");
    hint.className = "seat-hint";
    hint.textContent = "Tap the time again to open tickets ↗";
    return hint;
  }

  function render(chip, { layout, seats, time, runtimeMinutes, asOf }) {
    const parts = [];

    const end = endTimeLabel(time, runtimeMinutes);
    if (end) {
      // Showtime plus runtime: previews and ads run before the film, so the
      // real finish is later than this.
      const when = document.createElement("p");
      when.className = "seat-when";
      when.innerHTML = `<strong>Ends about ${end}</strong> <span>${formatRuntime(runtimeMinutes)} film, previews extra</span>`;
      parts.push(when);
    }

    const grid = document.createElement("div");
    grid.className = "seat-grid";
    grid.style.gridTemplateColumns = `repeat(${layout.totalColumns}, 1fr)`;
    seats.forEach((row, rowIndex) => {
      const types = layout.seatTypes?.[rowIndex] ?? "";
      for (let col = 0; col < row.length; col++) {
        const cell = document.createElement("span");
        cell.className = seatClass(row[col], types[col] ?? "S");
        grid.appendChild(cell);
      }
    });
    parts.push(grid);

    const hasDbox = (layout.seatTypes ?? []).some((row) => row.includes("D"));
    const legend = document.createElement("div");
    legend.className = "seat-legend";
    legend.innerHTML = `
      <span><span class="seat-swatch seat-available"></span> Available</span>
      <span><span class="seat-swatch seat-available-accessible"></span> Accessible</span>
      ${hasDbox ? '<span><span class="seat-swatch seat-available-dbox"></span> D-BOX</span>' : ""}
      <span><span class="seat-swatch seat-occupied"></span> Occupied</span>
    `;
    parts.push(legend);

    if (asOf) {
      const caption = document.createElement("p");
      caption.className = "seat-caption";
      caption.textContent = `Seats as of ${asOf}`;
      parts.push(caption);
    }

    const hint = touchHint(chip);
    if (hint) parts.push(hint);

    popoverEl().replaceChildren(...parts);
    place(chip);
  }

  // Says something in place of a map: that it's loading, or that there isn't one.
  function message(chip, text) {
    const note = document.createElement("p");
    note.className = "seat-message";
    note.textContent = text;
    const hint = touchHint(chip);
    popoverEl().replaceChildren(...(hint ? [note, hint] : [note]));
    place(chip);
  }

  // What to do with the map once it's known. A hovering pointer is shown
  // nothing for a time that has none, but a tap has already been spent on it.
  function present(chip, map) {
    if (map) render(chip, map);
    else if (!canHover()) message(chip, "No seat map for this showing.");
    else hide();
  }

  function show(chip, load) {
    const mine = ++request;
    activeChip = chip;
    if (popover) popover.hidden = true; // the last map shouldn't hang around while this one loads

    let result;
    try {
      result = load();
    } catch {
      result = null;
    }
    if (!result || typeof result.then !== "function") {
      present(chip, result);
      return;
    }

    const timer = setTimeout(() => {
      if (mine === request) message(chip, "Loading seat map…");
    }, LOADING_DELAY_MS);
    result.then(
      (map) => {
        clearTimeout(timer);
        if (mine === request) present(chip, map);
      },
      () => {
        clearTimeout(timer);
        if (mine === request) message(chip, "Couldn't load the seat map.");
      }
    );
  }

  function attach(chip, load) {
    chip.classList.add("has-seats");
    if (canHover()) {
      const open = () => {
        if (activeChip !== chip || popover?.hidden !== false) show(chip, load);
      };
      chip.addEventListener("mouseenter", open);
      chip.addEventListener("focus", open);
      chip.addEventListener("mouseleave", hide);
      chip.addEventListener("blur", hide);
    } else {
      // Touch: the first tap previews the seat map, a second tap on the same
      // time follows its ticket link. mouseenter isn't used here since touch
      // browsers fire a synthetic one right before "click", which would
      // otherwise make the map look "already open" and let the very first
      // tap fall through to the ticket page.
      chip.addEventListener("click", (e) => {
        if (activeChip !== chip) {
          e.preventDefault();
          show(chip, load);
        } else {
          activeChip = null;
        }
      });
    }
  }

  return { attach, endTimeLabel, formatRuntime, seatClass };
})();
