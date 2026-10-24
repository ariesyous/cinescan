// Shared snapshot renderer for theatre calendars and city/format pages.
// Kept as a plain script so the raw checkout needs no build or module server.
function renderSeatMap(container, session, layout, updatedAtLabel) {
  container.replaceChildren();
  const grid = document.createElement("div");
  grid.className = "seat-grid";
  grid.style.gridTemplateColumns = `repeat(${layout.totalColumns}, 1fr)`;
  let available = 0;
  let occupied = 0;
  session.seats.forEach((rowStr, rowIndex) => {
    const typeStr = layout.seatTypes?.[rowIndex] ?? "";
    for (let col = 0; col < rowStr.length; col++) {
      const ch = rowStr[col];
      const typeCh = typeStr[col] ?? "S";
      if (ch === "A") available++;
      if (ch === "O") occupied++;
      const cell = document.createElement("span");
      cell.className = "seat " + (ch === "A"
        ? typeCh === "W" || typeCh === "C" ? "seat-available-accessible"
          : typeCh === "D" ? "seat-available-dbox" : "seat-available"
        : ch === "O" ? "seat-occupied" : "seat-none");
      grid.appendChild(cell);
    }
  });
  grid.setAttribute("role", "img");
  grid.setAttribute("aria-label", `Seat map: ${available} available, ${occupied} occupied`);
  container.appendChild(grid);

  const hasDbox = (layout.seatTypes ?? []).some((row) => row.includes("D"));
  const legend = document.createElement("div");
  legend.className = "seat-legend";
  legend.innerHTML = `
    <span><span class="seat-swatch seat-available"></span> Available</span>
    <span><span class="seat-swatch seat-available-accessible"></span> Accessible</span>
    ${hasDbox ? '<span><span class="seat-swatch seat-available-dbox"></span> D-BOX</span>' : ""}
    <span><span class="seat-swatch seat-occupied"></span> Occupied</span>
  `;
  container.appendChild(legend);
  if (updatedAtLabel) {
    const caption = document.createElement("p");
    caption.className = "seat-caption";
    caption.textContent = `Seats as of ${updatedAtLabel}`;
    container.appendChild(caption);
  }
}
