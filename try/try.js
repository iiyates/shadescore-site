// The web version of ShadeScore's Score screen, driven by the same engine and data as the app.
"use strict";

const E = ShadeEngine;
const $ = id => document.getElementById(id);
const state = { venues: [], normals: {}, venue: null, geometry: null, plan: null,
  seat: { angle: 118, deck: 0, rowFraction: 0.55 }, roofOpen: true, scrub: 0, scrubbing: false, timer: null };

const DEFAULT_SEAT = { ballpark: { angle: 118, deck: 0, rowFraction: 0.55 }, oval: { angle: 90, deck: 0, rowFraction: 0.55 } };
const GROUP_LABEL = { "Major League Baseball": "Ballparks", "NFL": "Pro football", "College football": "College football" };

// ------------------------------------------------------------------ set-up

async function start() {
  const [venues, normals] = await Promise.all([
    fetch("../data/venues.json").then(r => r.json()), fetch("../data/normals.json").then(r => r.json())]);
  state.venues = venues; state.normals = normals;

  const select = $("venue");
  for (const group of ["Major League Baseball", "NFL", "College football"]) {
    const og = document.createElement("optgroup");
    og.label = GROUP_LABEL[group];
    venues.filter(v => v.group === group).sort((a, b) => a.name.localeCompare(b.name))
      .forEach(v => og.append(new Option(v.name, v.id)));
    select.append(og);
  }

  const q = new URLSearchParams(location.search);
  const venueId = venues.some(v => v.id === q.get("v")) ? q.get("v") : "fenway";
  $("date").value = q.get("date") || defaultDate();
  $("time").value = q.get("time") || "13:10";
  if (q.get("seat")) {
    const [a, d, r] = q.get("seat").split(",").map(Number);
    if ([a, d, r].every(Number.isFinite)) state.seat = { angle: a, deck: d, rowFraction: r };
  }
  selectVenue(venueId, !q.get("seat"), !q.get("event"));
  if (q.get("event")) $("event").value = q.get("event");

  select.addEventListener("change", () => selectVenue(select.value, true, true));
  ["date", "time", "event"].forEach(id => $(id).addEventListener("change", () => { state.scrubbing = false; recompute(); }));
  $("row").addEventListener("input", () => { state.seat.rowFraction = +$("row").value; recompute(); });
  $("scrub").addEventListener("input", () => { stop(); state.scrub = +$("scrub").value; state.scrubbing = true; draw(); });
  $("showAvg").addEventListener("click", () => { stop(); state.scrubbing = false; draw(); });
  $("play").addEventListener("click", togglePlay);
  document.querySelectorAll("#roofRow button").forEach(b => b.addEventListener("click", () => {
    state.roofOpen = b.dataset.roof === "open"; syncRoof(); recompute(); }));
  $("map").addEventListener("click", pickSeat);
  addEventListener("resize", drawMap);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);
  document.addEventListener("keydown", e => {
    if (e.target.matches("input, select")) return;
    if (e.key === " ") { e.preventDefault(); togglePlay(); }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { step(e.key === "ArrowRight" ? 1 : -1); }
  });
}

function defaultDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function selectVenue(id, resetSeat, resetEvent) {
  const v = state.venues.find(x => x.id === id);
  state.venue = v; state.geometry = new E.Geometry(v);
  $("venue").value = id;
  $("venueSub").textContent = v.team ? `${v.team} · ${v.city}` : v.city;
  if (resetSeat) state.seat = { ...DEFAULT_SEAT[v.shape] };
  state.seat.deck = Math.min(state.seat.deck, state.geometry.deckCount - 1);
  if (resetEvent) $("event").value = v.group === "Major League Baseball" ? "190" : "195";
  $("roofRow").hidden = v.roof !== "retractable";
  state.roofOpen = true; syncRoof();
  const decks = $("decks"); decks.innerHTML = "";
  state.geometry.deckNames().forEach((name, i) => {
    const b = document.createElement("button"); b.type = "button"; b.textContent = name;
    b.addEventListener("click", () => { state.seat.deck = i; recompute(); });
    decks.append(b);
  });
  state.scrubbing = false;
  recompute();
}

function syncRoof() {
  document.querySelectorAll("#roofRow button").forEach(b =>
    b.classList.toggle("on", (b.dataset.roof === "open") === state.roofOpen));
}

// ------------------------------------------------------------------ the answer

function recompute() {
  const v = state.venue;
  const [y, mo, d] = $("date").value.split("-").map(Number);
  const [h, mi] = $("time").value.split(":").map(Number);
  if (!y || !Number.isFinite(h)) return;
  const startAt = E.zoned(y, mo, d, h, mi, v.timeZone);
  const daysInMonth = new Date(y, mo, 0).getDate();
  const conditions = E.typicalConditions(state.normals[v.id] || state.normals.fenway, mo, d, daysInMonth, h + mi / 60);
  state.plan = E.plan(v, state.geometry, state.seat, startAt, +$("event").value, conditions, state.roofOpen);
  state.month = new Date(y, mo - 1, 1).toLocaleString("en-US", { month: "long" });
  if (state.scrub >= state.plan.samples.length) state.scrub = 0;
  $("scrub").max = state.plan.samples.length - 1;
  updateURL();
  draw();
}

function updateURL() {
  const s = state.seat;
  const q = new URLSearchParams({ v: state.venue.id, date: $("date").value, time: $("time").value,
    event: $("event").value, seat: [Math.round(s.angle), s.deck, s.rowFraction.toFixed(2)].join(",") });
  history.replaceState(null, "", "?" + q.toString());
}

const timeText = date => date.toLocaleTimeString("en-US", { timeZone: state.venue.timeZone, hour: "numeric", minute: "2-digit" });
const deg = x => `${Math.round(x)}°`;
const uvText = x => x < 0.05 ? "0" : x.toFixed(1);

function draw() {
  const p = state.plan, v = state.venue, g = state.geometry;
  if (!p) return;
  const moment = state.scrubbing ? p.samples[state.scrub] : null;

  // Ring and number.
  const circumference = 2 * Math.PI * 82;
  $("ringShade").style.strokeDasharray = `${p.shadeFraction * circumference} ${circumference}`;
  $("ringShade").style.strokeOpacity = p.shadeFraction > 0 ? 1 : 0;   // no stray cap dot at 0%
  $("pct").textContent = `${p.shadePercent}%`;
  $("pct").style.color = p.shadePercent >= 50 ? "var(--shade)" : "var(--sun)";

  // Tiles.
  $("momentTitle").textContent = moment ? `At ${timeText(moment.date)}` : "Averages during the game";
  $("showAvg").hidden = !moment;
  $("air").textContent = deg(p.conditions.temperatureF);
  $("seatTemp").textContent = deg(moment ? moment.feelsLike : p.averageSeatFeels);
  $("uv").textContent = uvText(moment ? moment.uv : p.averageUV);
  const shaded = moment ? moment.shaded : p.shadePercent >= 50;
  $("seatTile").className = `tile seat ${shaded ? "shadeT" : "sun"} ${moment ? "moment" : ""}`;
  $("wxNote").textContent = `Weather: typical for ${state.month} at ${v.name}. The app uses a real forecast for games in the next 10 days.`;
  $("airLegend").textContent = `– – Air ${deg(p.conditions.temperatureF)}`;

  // Seat.
  const seat = p.seat;
  $("spot").textContent = E.spotName(v, state.seat.angle);
  $("row").value = state.seat.rowFraction;
  $("rowText").textContent = `${seat.row} of ${Math.round(seat.rows)}`;
  [...$("decks").children].forEach((b, i) => b.classList.toggle("on", i === seat.deck));

  // Timeline.
  $("strip").innerHTML = p.samples.map((s, i) =>
    `<i class="${s.shaded ? "s" : ""} ${moment && i === state.scrub ? "cur" : ""}"></i>`).join("");
  $("scrub").value = state.scrub;
  $("t0").textContent = timeText(p.samples[0].date);
  $("t1").textContent = timeText(p.samples[p.samples.length - 1].date);
  $("play").textContent = state.timer ? "❚❚" : "▶";

  drawChart(moment);
  drawMap();
}

function drawChart(moment) {
  const p = state.plan, n = p.samples.length, W = 600, H = 140;
  const values = p.samples.map(s => s.feelsLike).concat([p.conditions.temperatureF]);
  const lo = Math.min(...values) - 4, hi = Math.max(Math.max(...values) + 4, lo + 10);
  const x = i => n > 1 ? i / (n - 1) * W : W / 2;
  const y = t => H - 6 - (t - lo) / (hi - lo) * (H - 26);
  const stops = p.samples.map((s, i) =>
    `<stop offset="${n > 1 ? i / (n - 1) : 0}" stop-color="${s.shaded ? "var(--shade)" : "var(--sun)"}"/>`).join("");
  const pts = p.samples.map((s, i) => [x(i), y(s.feelsLike)]);
  const line = pts.map((pt, i) => (i ? "L" : "M") + pt[0].toFixed(1) + "," + pt[1].toFixed(1)).join("");
  const area = line + `L${W},${H}L0,${H}Z`;
  let marker = "";
  if (moment) {
    const [mx, my] = pts[state.scrub];
    marker = `<line x1="${mx}" y1="0" x2="${mx}" y2="${H}" stroke="currentColor" stroke-opacity=".25"/>
      <circle cx="${mx}" cy="${my}" r="6" fill="${moment.shaded ? "var(--shade)" : "var(--sun)"}" stroke="var(--card)" stroke-width="2.5"/>`;
  }
  const first = p.samples[0], last = p.samples[n - 1];
  $("chart").innerHTML = `<defs><linearGradient id="ss" x1="0" x2="1" y1="0" y2="0">${stops}</linearGradient></defs>
    <path d="${area}" fill="url(#ss)" fill-opacity=".16"/>
    <line x1="0" x2="${W}" y1="${y(p.conditions.temperatureF)}" y2="${y(p.conditions.temperatureF)}" stroke="currentColor" stroke-opacity=".35" stroke-dasharray="4 4"/>
    <path d="${line}" fill="none" stroke="url(#ss)" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    ${moment ? "" : `<text x="4" y="${y(first.feelsLike) - 8}" font-size="13" font-weight="600" fill="${first.shaded ? "var(--shade)" : "var(--sun)"}">${deg(first.feelsLike)}</text>
    <text x="${W - 4}" y="${y(last.feelsLike) - 8}" text-anchor="end" font-size="13" font-weight="600" fill="${last.shaded ? "var(--shade)" : "var(--sun)"}">${deg(last.feelsLike)}</text>`}
    ${marker}`;
}

// ------------------------------------------------------------------ the map

function projection(size) {
  const g = state.geometry, o = g.orientation;
  let minX = 0, maxX = 0, minY = 0, maxY = 0;
  for (let i = 0; i < 72; i++) {
    const angle = -180 + i * 5, b = (o + angle) * Math.PI / 180;
    const r = (g.decks(angle).at(-1)?.back ?? 100) + 6;
    const x = Math.sin(b) * r, y = -Math.cos(b) * r;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const pad = 26, scale = Math.min((size - pad * 2) / (maxX - minX), (size - pad * 2) / (maxY - minY));
  const ox = size / 2 - (minX + maxX) / 2 * scale, oy = size / 2 - (minY + maxY) / 2 * scale;
  return {
    point: (angle, r) => { const b = (o + angle) * Math.PI / 180; return [ox + Math.sin(b) * r * scale, oy - Math.cos(b) * r * scale]; },
    invert: (px, py) => {
      const x = px - ox, y = py - oy, radius = Math.hypot(x, y) / scale;
      const bearing = ((Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360;
      let angle = ((bearing - o + 180) % 360 + 360) % 360 - 180;
      return [angle, radius];
    },
  };
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function drawMap() {
  const canvas = $("map"), p = state.plan, g = state.geometry, v = state.venue;
  if (!p) return;
  const size = canvas.clientWidth, dpr = devicePixelRatio || 1;
  canvas.width = size * dpr; canvas.height = size * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  ctx.fillStyle = dark ? "#1f2a31" : "#f3f6f8"; ctx.fillRect(0, 0, size, size);
  const proj = projection(size);
  const sample = p.samples[state.scrubbing ? state.scrub : 0];

  const poly = (pts, fill) => { ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(...q) : ctx.moveTo(...q)); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
  poly(Array.from({ length: 72 }, (_, i) => proj.point(-180 + i * 5, g.innerRadius(-180 + i * 5))), dark ? "rgba(86,114,74,.55)" : "rgba(127,156,108,.5)");

  const sun = dark ? "rgb(138,90,22)" : "rgb(243,200,126)", shade = dark ? "rgb(30,76,87)" : "rgb(159,195,202)";
  for (const s of E.sections(g, sample.sun, p.covered)) {
    const pts = s.corners.map(([a, r]) => proj.point(a, r));
    poly(pts, s.shaded ? shade : sun);
    ctx.strokeStyle = s.shaded ? shade : sun; ctx.lineWidth = 0.6; ctx.stroke();
  }

  // Seat marker.
  const [sx, sy] = proj.point(state.seat.angle, p.seat.radius);
  ctx.beginPath(); ctx.arc(sx, sy, 11, 0, 7); ctx.fillStyle = dark ? "#e8eef0" : "#1b2328"; ctx.fill();
  ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fillStyle = dark ? "#1b2328" : "#fff"; ctx.fill();

  // Sun direction.
  if (sample.sun.altitude > 0 && !p.covered) {
    const b = sample.sun.azimuth * Math.PI / 180, r = size / 2 - 16;
    const px = size / 2 + Math.sin(b) * r, py = size / 2 - Math.cos(b) * r;
    ctx.setLineDash([7, 6]); ctx.strokeStyle = css("--sun"); ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(size / 2 - Math.sin(b) * r * 0.2, size / 2 + Math.cos(b) * r * 0.2); ctx.stroke();
    ctx.setLineDash([]); ctx.beginPath(); ctx.arc(px, py, 13, 0, 7); ctx.fillStyle = css("--sun"); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = "600 11px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(`${Math.round(sample.sun.altitude)}°`, px, py);
  }
  ctx.fillStyle = css("--muted"); ctx.font = "700 13px -apple-system, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("N", size / 2, 13);
  const labels = v.shape === "oval" ? [["END", 0, 0.6], ["END", 180, 0.6]] : [["CF", 0, 0.72], ["HOME", 180, 0.4]];
  ctx.font = "600 11px -apple-system, sans-serif";
  for (const [t, a, k] of labels) ctx.fillText(t, ...proj.point(a, g.innerRadius(a) * k));
}

function pickSeat(e) {
  const canvas = $("map"), rect = canvas.getBoundingClientRect();
  const [angle, radius] = projection(rect.width).invert(e.clientX - rect.left, e.clientY - rect.top);
  const stack = state.geometry.decks(angle);
  let best = 0, bestD = Infinity;
  stack.forEach((d, i) => { const dist = Math.abs(radius - (d.front + d.depth / 2)); if (dist < bestD) { bestD = dist; best = i; } });
  const deck = stack[best];
  state.seat = { angle: Math.round(angle), deck: best, rowFraction: Math.min(1, Math.max(0, (radius - deck.front) / deck.depth)) };
  recompute();
}

// ------------------------------------------------------------------ playing the game through

function togglePlay() {
  if (state.timer) { stop(); draw(); return; }
  const n = state.plan.samples.length;
  if (!state.scrubbing || state.scrub >= n - 1) state.scrub = 0;
  state.scrubbing = true;
  state.timer = setInterval(() => {
    if (state.scrub >= state.plan.samples.length - 1) { stop(); draw(); return; }
    state.scrub++; draw();
  }, 350);
  draw();
}

function stop() { clearInterval(state.timer); state.timer = null; }

function step(delta) {
  stop();
  const n = state.plan.samples.length;
  const from = state.scrubbing ? state.scrub : (delta > 0 ? -1 : n);
  state.scrub = Math.min(n - 1, Math.max(0, from + delta)); state.scrubbing = true; draw();
}

start();
