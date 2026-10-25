// Enhance the snapshot HTML without replacing it or fetching Cineplex APIs.
(() => {
  const snapshots = new Map();
  const popover = document.createElement("div");
  popover.id = "landing-seat-preview";
  popover.className = "seat-popover";
  popover.hidden = true;
  popover.setAttribute("role", "status");
  document.body.appendChild(popover);
  const supportsHover = window.matchMedia("(hover: hover)").matches;
  let activeChip = null;
  let request = 0;

  function hide() {
    request++;
    if (activeChip) {
      activeChip.classList.remove("seat-preview-active");
      activeChip.setAttribute("aria-expanded", "false");
    }
    activeChip = null;
    popover.hidden = true;
  }

  function position(chip) {
    const rect = chip.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    const left = Math.max(8, Math.min(rect.left, width - box.width - 8));
    let top = rect.bottom + 6;
    if (top + box.height > window.innerHeight - 8 && rect.top > box.height + 8) {
      top = rect.top - box.height - 6;
    }
    popover.style.left = `${left + window.scrollX}px`;
    popover.style.top = `${top + window.scrollY}px`;
  }

  async function show(chip) {
    hide();
    activeChip = chip;
    const token = request;
    chip.classList.add("seat-preview-active");
    chip.setAttribute("aria-expanded", "true");
    popover.textContent = "Loading seat map…";
    popover.hidden = false;
    position(chip);
    try {
      const file = chip.dataset.file;
      if (!snapshots.has(file)) {
        snapshots.set(file, fetch(file).then((response) => {
          if (!response.ok) throw new Error("Snapshot unavailable");
          return response.json();
        }).catch((error) => {
          snapshots.delete(file); // A later interaction can retry.
          throw error;
        }));
      }
      const data = await snapshots.get(file);
      if (token !== request) return;
      const [dayIndex, movieIndex, sessionIndex] = chip.dataset.session.split(",").map(Number);
      const day = data.days?.[dayIndex];
      const session = day?.movies?.[movieIndex]?.sessions?.[sessionIndex];
      const expected = chip.querySelector("time").getAttribute("datetime");
      const layout = data.auditoriums?.[session?.layoutKey];
      // A newer deployment must not silently show another session's seats
      // if the JSON indices have changed since this HTML was loaded.
      if (!layout || !session.seats || String(session.layoutKey) !== chip.dataset.layout ||
          `${day.date}T${session.time}` !== expected) throw new Error("Session changed");
      const updatedAtLabel = data.updatedAt ? new Date(data.updatedAt).toLocaleString("en-US", {
        timeZone: "America/Toronto", year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }) : "";
      renderSeatMap(popover, session, layout, updatedAtLabel);
    } catch {
      if (token !== request) return;
      popover.textContent = "Seat map unavailable in this snapshot. Open the theatre calendar to check again.";
    }
    if (token === request) position(chip);
  }

  for (const chip of document.querySelectorAll(".landing-times .has-seats")) {
    chip.setAttribute("aria-controls", popover.id);
    chip.setAttribute("aria-expanded", "false");
    if (supportsHover) {
      chip.addEventListener("mouseenter", () => show(chip));
      chip.addEventListener("mouseleave", hide);
      chip.addEventListener("focus", () => show(chip));
      chip.addEventListener("blur", hide);
    }
    chip.addEventListener("click", (event) => {
      if (!supportsHover && activeChip !== chip) {
        event.preventDefault();
        show(chip);
      }
    });
  }
  document.addEventListener("click", (event) => {
    if (activeChip && !activeChip.contains(event.target) && !popover.contains(event.target)) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  window.addEventListener("resize", () => {
    if (activeChip && !popover.hidden) position(activeChip);
  });

  // One date at a time, picked from the date strip or the URL hash. Without
  // this script every date is listed in order and the strip links jump.
  const dayEls = [...document.querySelectorAll(".landing-day")];
  const dateStrip = document.querySelector(".landing-dates");
  const dateLinks = [...document.querySelectorAll(".landing-date")];
  function showDay(id) {
    const dayEl = dayEls.find((el) => el.id === id) ?? dayEls[0];
    if (!dayEl) return;
    hide();
    for (const el of dayEls) el.hidden = el !== dayEl;
    for (const link of dateLinks) {
      if (link.hash !== `#${dayEl.id}`) {
        link.removeAttribute("aria-current");
        continue;
      }
      link.setAttribute("aria-current", "date");
      // Centre it in the strip without scrolling the page.
      dateStrip.scrollLeft = link.offsetLeft - (dateStrip.clientWidth - link.offsetWidth) / 2;
    }
  }
  for (const link of dateLinks) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      const url = new URL(location.href);
      url.hash = link.hash;
      history.replaceState(history.state, "", url);
      showDay(link.hash.slice(1));
    });
  }
  window.addEventListener("hashchange", () => showDay(location.hash.slice(1)));
  showDay(location.hash.slice(1));

  // Format chips narrow the times to sessions in any selected format, and
  // carry the selection in the URL like the theatre and movie filters.
  const filterEl = document.getElementById("landing-filter");
  if (!filterEl) return;
  const chips = [...filterEl.querySelectorAll(".format-chip")];
  const allBtn = filterEl.querySelector(".format-clear-btn");
  const knownTags = new Set(chips.map((chip) => chip.dataset.tag));
  const urlFormats = new URLSearchParams(location.search).get("formats");
  let selected = new Set((urlFormats || "").split(",").filter((tag) => knownTags.has(tag)));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  // Links on format pages already name that page's format; others follow the chips.
  const links = [...document.querySelectorAll(".landing-movie a:not(.session)")]
    .filter((link) => !new URL(link.href).searchParams.has("formats"));

  function apply() {
    for (const chip of chips) chip.classList.toggle("active", selected.has(chip.dataset.tag));
    allBtn.classList.toggle("active", selected.size === 0);
    const url = new URL(location.href);
    if (selected.size) url.searchParams.set("formats", [...selected].join(","));
    else url.searchParams.delete("formats");
    history.replaceState(history.state, "", url);
    hide();

    for (const wrap of document.querySelectorAll(".landing-times .session-wrap")) {
      wrap.hidden = selected.size > 0 && !wrap.dataset.formats.split("|").some((tag) => selected.has(tag));
    }
    for (const dayEl of dayEls) {
      let movies = 0;
      for (const movieEl of dayEl.querySelectorAll(".landing-movie")) {
        let theatres = 0;
        let times = 0;
        for (const theatreEl of movieEl.querySelectorAll(".landing-theatre")) {
          const shown = theatreEl.querySelectorAll(".session-wrap:not([hidden])").length;
          theatreEl.hidden = shown === 0;
          if (shown) theatres++;
          times += shown;
        }
        movieEl.hidden = theatres === 0;
        if (theatres) movies++;
        movieEl.querySelector(".landing-movie-meta").textContent =
          `${plural(theatres, "theatre")} · ${plural(times, "showtime")}`;
      }
      let note = dayEl.querySelector(".landing-no-match");
      if (!movies && !note) {
        note = document.createElement("p");
        note.className = "landing-no-match";
        note.textContent = "No showtimes in the selected formats on this date.";
        dayEl.appendChild(note);
      }
      if (note) note.hidden = movies > 0;
      dateLinks.find((link) => link.hash === `#${dayEl.id}`)?.classList.toggle("landing-date-empty", !movies);
    }
    for (const link of links) {
      const target = new URL(link.href);
      if (selected.size) target.searchParams.set("formats", [...selected].join(","));
      else target.searchParams.delete("formats");
      link.href = target;
    }
  }

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      if (selected.has(chip.dataset.tag)) selected.delete(chip.dataset.tag);
      else selected.add(chip.dataset.tag);
      apply();
    });
  }
  allBtn.addEventListener("click", () => {
    selected = new Set();
    apply();
  });
  filterEl.hidden = false;
  apply();
})();
