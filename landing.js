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
      renderSeatMap(popover, session, layout, data.updatedAt);
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

  function openDate() {
    const target = document.getElementById(location.hash.slice(1));
    if (target?.classList.contains("landing-day")) {
      target.open = true;
      target.scrollIntoView();
    }
  }
  for (const link of document.querySelectorAll(".landing-date-picker a")) {
    link.addEventListener("click", () => {
      const target = document.getElementById(new URL(link.href).hash.slice(1));
      if (target) target.open = true;
      link.closest("details").open = false;
      hide();
    });
  }
  window.addEventListener("hashchange", openDate);
  openDate();
})();
