// ShadeScore's shade engine for the web: a line-for-line port of the app's model
// (ios/Scripts/verify_engine.py is the tested Python twin this follows). Venue data and
// climate normals are the app's own files, copied to /data.
"use strict";

const ShadeEngine = (() => {
  const RAD = Math.PI / 180, DEG = 180 / Math.PI, FEET = 0.3048, BIN_COUNT = 240;

  // ---------------------------------------------------------------- the sun (NOAA)

  function solarPosition(date, latitude, longitude) {
    const julian = date.getTime() / 86400000 + 2440587.5;
    const t = (julian - 2451545) / 36525;
    let meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    if (meanLongitude < 0) meanLongitude += 360;
    const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const centre = Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
      + Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t)
      + Math.sin(3 * meanAnomaly * RAD) * 0.000289;
    const omega = 125.04 - 1934.136 * t;
    const apparent = meanLongitude + centre - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
    const obliquity = 23 + (26 + seconds / 60) / 60 + 0.00256 * Math.cos(omega * RAD);
    const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparent * RAD));
    const y = Math.tan(obliquity * RAD / 2) ** 2;
    const eot = 4 * DEG * (y * Math.sin(2 * meanLongitude * RAD)
      - 2 * e * Math.sin(meanAnomaly * RAD)
      + 4 * e * y * Math.sin(meanAnomaly * RAD) * Math.cos(2 * meanLongitude * RAD)
      - 0.5 * y * y * Math.sin(4 * meanLongitude * RAD)
      - 1.25 * e * e * Math.sin(2 * meanAnomaly * RAD));
    const minutesUTC = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    let trueSolar = (minutesUTC + eot + 4 * longitude) % 1440;
    if (trueSolar < 0) trueSolar += 1440;
    const hourAngle = (trueSolar / 4 - 180) * RAD;
    const phi = latitude * RAD;
    const sinAlt = Math.sin(phi) * Math.sin(declination)
      + Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
    const altitude = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
    const azimuth = Math.atan2(Math.sin(hourAngle),
      Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi)) * DEG + 180;
    return { altitude, azimuth: ((azimuth % 360) + 360) % 360 };
  }

  // ---------------------------------------------------------------- the bowl

  const ramp = (x, low, high) => Math.min(1, Math.max(0, (x - low) / (high - low)));

  class Geometry {
    constructor(venue) {
      this.venue = venue;
      this.orientation = venue.orientation;
      let inner, rowsAt;
      if (venue.shape === "ballpark") {
        const spec = venue.ballpark;
        const distances = spec.distances.map(d => d * FEET);
        const backstop = spec.backstop * FEET;
        const rows = spec.rows;
        inner = angle => {
          const a = Math.abs(angle);
          if (a <= 45) {
            const x = (angle + 45) / 22.5;
            const i = Math.min(3, Math.floor(x));
            const f = x - i;
            return distances[i] * (1 - f) + distances[i + 1] * f;
          }
          const pole = angle > 0 ? distances[4] : distances[0];
          const points = [[45, pole], [62, pole * 0.50], [90, Math.max(backstop * 1.9, 32)],
            [120, Math.max(backstop * 1.4, 23)], [150, backstop * 1.15], [180, backstop]];
          for (let i = 0; i < points.length - 1; i++) {
            if (points[i][0] <= a && a <= points[i + 1][0]) {
              const f = (a - points[i][0]) / (points[i + 1][0] - points[i][0]);
              return points[i][1] * (1 - f) + points[i + 1][1] * f;
            }
          }
          return backstop;
        };
        rowsAt = angle => {
          const a = Math.abs(angle);
          return [Math.max(10, rows[0] * (0.55 + 0.45 * ramp(a, 0, 70))),
            rows[1] * ramp(a, 42, 80), rows[2] * ramp(a, 55, 95)];
        };
      } else {
        const spec = venue.oval;
        const rows = spec.rows;
        inner = angle => {
          const c = Math.abs(Math.cos(angle * RAD)), s = Math.abs(Math.sin(angle * RAD));
          const n = 3.0;
          return ((c / spec.semiMajor) ** n + (s / spec.semiMinor) ** n) ** (-1 / n);
        };
        rowsAt = angle => {
          const s = Math.abs(Math.sin(angle * RAD));
          return [rows[0], rows[1], rows[2] * (0.78 + 0.22 * s)];
        };
      }
      this.bins = []; this.innerBins = []; this.maxRadius = 0; this.maxHeight = 0;
      for (let i = 0; i < BIN_COUNT; i++) {
        const angle = -180 + (i + 0.5) * 360 / BIN_COUNT;
        const r = rowsAt(angle);
        const stack = [];
        const lower = { front: inner(angle) + 3.5, z: 1.2, depth: r[0] * 0.78, tread: 0.78, rise: 0.40, rows: r[0] };
        lower.back = lower.front + lower.depth; lower.backZ = lower.z + r[0] * 0.40;
        stack.push(lower);
        if (r[1] > 2.5) {
          const club = { front: lower.back - 7.0, z: lower.backZ + 4.6, depth: r[1] * 0.82, tread: 0.82, rise: 0.45, rows: r[1] };
          club.back = club.front + club.depth; club.backZ = club.z + r[1] * 0.45;
          stack.push(club);
        }
        if (r[2] > 2.5) {
          const prev = stack[stack.length - 1];
          const upper = { front: prev.back - 7.5, z: prev.backZ + 5.6, depth: r[2] * 0.86, tread: 0.86, rise: 0.55, rows: r[2] };
          upper.back = upper.front + upper.depth; upper.backZ = upper.z + r[2] * 0.55;
          stack.push(upper);
        }
        this.bins.push(stack);
        this.innerBins.push(inner(angle));
        this.maxRadius = Math.max(this.maxRadius, stack[stack.length - 1].back);
        for (const d of stack) this.maxHeight = Math.max(this.maxHeight, d.backZ);
      }
      this.deckCount = Math.max(...this.bins.map(s => s.length));
    }

    bin(angle) {
      let i = Math.floor((angle + 180) / 360 * BIN_COUNT);
      if (i < 0) i += BIN_COUNT;
      if (i >= BIN_COUNT) i -= BIN_COUNT;
      return i;
    }
    decks(angle) { return this.bins[this.bin(angle)]; }
    innerRadius(angle) { return this.innerBins[this.bin(angle)]; }

    standHeight(angle, radius) {
      let height = 0;
      for (const d of this.bins[this.bin(angle)]) {
        if (d.front - 0.4 <= radius && radius <= d.back + 22) {
          const h = d.z + (Math.min(radius, d.back) - d.front) / d.tread * d.rise;
          height = Math.max(height, h);
        }
      }
      return height;
    }

    seat(angle, deckIndex, rowFraction) {
      const stack = this.decks(angle);
      const index = Math.min(Math.max(0, deckIndex), stack.length - 1);
      const deck = stack[index];
      const fraction = Math.min(1, Math.max(0, rowFraction));
      const radius = deck.front + deck.depth * fraction;
      const height = deck.z + (deck.depth * fraction) / deck.tread * deck.rise;
      let soffit = null, edge = null;
      if (index + 1 < stack.length) {
        const above = stack[index + 1];
        if (radius > above.front) { soffit = above.z - 1.3; edge = above.front; }
      }
      return { radius, height, angle, soffit, edge, deck: index, rows: deck.rows,
        row: Math.max(1, Math.round(1 + fraction * (deck.rows - 1))) };
    }

    deckNames() {
      return this.deckCount === 3 ? ["Lower", "Club", "Upper"]
        : this.deckCount === 2 ? ["Lower", "Upper"] : ["Lower"];
    }
  }

  // ---------------------------------------------------------------- shade

  function isShaded(geometry, seat, sun) {
    const { altitude, azimuth } = sun;
    if (altitude <= 1.5) return true;
    const tanAlt = Math.tan(altitude * RAD);
    const sunField = (azimuth - geometry.orientation) * RAD;
    const head = seat.height + 1.05;
    if (seat.soffit !== null) {
      const clearance = seat.soffit - head;
      if (clearance <= 0) return true;
      const towardsBack = Math.cos(sunField - seat.angle * RAD);
      if (towardsBack >= -0.03) return true;
      const distance = (seat.radius - seat.edge) / (-towardsBack);
      if (tanAlt > clearance / distance) return true;
    }
    const x0 = seat.radius * Math.cos(seat.angle * RAD), y0 = seat.radius * Math.sin(seat.angle * RAD);
    const dx = Math.cos(sunField), dy = Math.sin(sunField);
    const far = geometry.maxRadius * 2.3;
    for (let t = 2.0; t <= far; t += 3.2) {
      const ray = head + t * tanAlt;
      if (ray > geometry.maxHeight) break;
      const x = x0 + dx * t, y = y0 + dy * t;
      const radius = Math.hypot(x, y);
      if (radius <= geometry.maxRadius + 24) {
        const angle = Math.atan2(y, x) * DEG;
        if (ray < geometry.standHeight(angle, radius)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- comfort and UV

  function clearSkyIrradiance(alt) {
    if (alt <= 0.5) return 0;
    const s = Math.sin(alt * RAD);
    return 1098 * s * Math.exp(-0.059 / s);
  }

  function feelsLike(tempF, humidity, windMph, cloudPct, sunAlt, inShade) {
    const t = (tempF - 32) * 5 / 9;
    const wind = Math.max(0, windMph) * 0.44704;
    const rh = Math.min(100, Math.max(1, humidity));
    const vapour = 6.112 * Math.exp(17.625 * t / (243.04 + t)) * rh / 100;
    const cloud = Math.min(1, Math.max(0, cloudPct / 100));
    const global = clearSkyIrradiance(sunAlt) * (1 - 0.75 * cloud ** 3.4);
    const diffuse = global * Math.min(1, 0.16 + 0.62 * cloud);
    const absorbed = Math.min(160, 0.13 * (inShade ? diffuse : global));
    let apparent = t + 0.348 * vapour - 0.70 * wind + 0.70 * absorbed / (wind + 10) - 4.25;
    if (t < 10 && windMph > 3) {
      const chillF = 35.74 + 0.6215 * tempF - 35.75 * windMph ** 0.16 + 0.4275 * tempF * windMph ** 0.16;
      apparent = Math.min(apparent, (chillF - 32) * 5 / 9 + (inShade ? 0 : 1.8));
    }
    return apparent * 9 / 5 + 32;
  }

  const clearSkyUV = (alt, elevation) => alt <= 0 ? 0 : 12.5 * Math.sin(alt * RAD) ** 2.42 * (1 + 0.00006 * elevation);
  const ambientUV = (alt, elevation, c) => clearSkyUV(alt, elevation) * (1 - 0.6 * Math.min(1, Math.max(0, c.cloudPercent / 100)));
  const seatUV = (ambient, inShade, underDeck) => inShade ? ambient * 0.5 * (underDeck ? 0.45 : 0.9) : ambient;
  const shelter = seat => seat.soffit !== null ? 0.35 : seat.deck === 0 ? 0.6 : seat.deck === 1 ? 0.78 : 0.95;

  function humidity(tempF, dewF) {
    const t = (tempF - 32) * 5 / 9, d = (dewF - 32) * 5 / 9;
    const e = 6.112 * Math.exp(17.625 * d / (243.04 + d));
    const es = 6.112 * Math.exp(17.625 * t / (243.04 + t));
    return Math.min(100, Math.max(1, 100 * e / es));
  }

  // ---------------------------------------------------------------- time at the venue

  /** The UTC instant of a wall-clock time in the venue's own time zone. */
  function zoned(y, mo, d, h, mi, timeZone) {
    let guess = Date.UTC(y, mo - 1, d, h, mi);
    for (let i = 0; i < 2; i++) {   // two passes settle daylight-saving edges
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess))
        .map(p => [p.type, p.value]));
      const seen = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
      guess += Date.UTC(y, mo - 1, d, h, mi) - seen;
    }
    return new Date(guess);
  }

  // ---------------------------------------------------------------- typical weather

  /** The app's climate normals for a date and hour: monthly rows blended, shaped by the hour. */
  function typicalConditions(table, month, day, daysInMonth, hour) {
    const m = month - 1;
    const fraction = (day - 0.5) / daysInMonth;
    const neighbour = fraction < 0.5 ? (m + 11) % 12 : (m + 1) % 12;
    const w = Math.abs(fraction - 0.5);
    const a = table[m], b = table[neighbour];
    const mix = k => a[k] * (1 - w) + b[k] * w;
    const high = mix(0), low = mix(1), dew = mix(2), wind = mix(3), cloud = mix(4);
    const t = (hour - 6) % 24, phase = t < 0 ? t + 24 : t, range = high - low;
    const temperatureF = phase <= 9 ? low + range * 0.5 * (1 - Math.cos(Math.PI * phase / 9))
      : high - range * 0.5 * (1 - Math.cos(Math.PI * (phase - 9) / 15));
    return { temperatureF, humidity: humidity(temperatureF, dew), windMph: wind, cloudPercent: cloud };
  }

  // ---------------------------------------------------------------- the plan

  /** Everything for one seat through one event, every ten minutes, as the app works it out. */
  function plan(venue, geometry, seatChoice, start, minutesLong, conditions, roofOpen) {
    const covered = venue.roof === "dome" || (venue.roof === "retractable" && !roofOpen);
    const seat = geometry.seat(seatChoice.angle, seatChoice.deck, seatChoice.rowFraction);
    const windInSeat = conditions.windMph * shelter(seat);
    const samples = [];
    for (let minutes = 0; minutes <= minutesLong; minutes += 10) {
      const date = new Date(start.getTime() + minutes * 60000);
      const sun = solarPosition(date, venue.latitude, venue.longitude);
      const shaded = covered ? true : isShaded(geometry, seat, sun);
      const ambient = covered ? 0 : ambientUV(sun.altitude, venue.elevation, conditions);
      const alt = covered ? 0 : sun.altitude;
      const feels = inShade => feelsLike(conditions.temperatureF, conditions.humidity, windInSeat,
        conditions.cloudPercent, alt, inShade);
      const inSun = feels(false), inShadeF = feels(true);
      samples.push({ date, sun, shaded, uv: seatUV(ambient, shaded, seat.soffit !== null),
        feelsLike: shaded ? inShadeF : inSun });
    }
    const n = samples.length;
    const shadedCount = samples.filter(s => s.shaded).length;
    return {
      samples, seat, covered, conditions,
      shadePercent: Math.round(shadedCount / n * 100),
      shadeFraction: shadedCount / n,
      averageSeatFeels: samples.reduce((a, s) => a + s.feelsLike, 0) / n,
      averageUV: samples.reduce((a, s) => a + s.uv, 0) / n,
    };
  }

  /** Is each slice of seating shaded at this moment? For drawing the map. */
  function sections(geometry, sun, covered, segments = 72, bands = 3) {
    const out = [];
    for (let i = 0; i < segments; i++) {
      const a0 = -180 + i * 360 / segments, a1 = -180 + (i + 1) * 360 / segments;
      const mid = -180 + (i + 0.5) * 360 / segments;
      const s0 = geometry.decks(a0), s1 = geometry.decks(a1);
      const count = Math.min(s0.length, s1.length);
      for (let deck = 0; deck < count; deck++) {
        for (let band = 0; band < bands; band++) {
          const probe = geometry.seat(mid, deck, (band + 0.5) / bands);
          const shaded = covered || isShaded(geometry, probe, sun);
          const lo = band / bands, hi = (band + 1) / bands;
          out.push({ shaded, corners: [
            [a0, s0[deck].front + s0[deck].depth * lo], [a1, s1[deck].front + s1[deck].depth * lo],
            [a1, s1[deck].front + s1[deck].depth * hi], [a0, s0[deck].front + s0[deck].depth * hi]] });
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- naming spots

  const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  const compass = b => COMPASS[Math.floor((((b % 360) + 360) % 360 + 11.25) / 22.5) % 16];

  function spotName(venue, angle) {
    const a = Math.abs(angle);
    if (venue.shape === "oval") {
      const side = compass(venue.orientation + angle);
      if (a <= 20) return `End zone (${side})`;
      if (a <= 52) return `Corner (${side})`;
      if (a <= 74) return `25-yard line (${side})`;
      return `50-yard line (${side})`;
    }
    const side = angle > 0 ? "first-base" : "third-base";
    const field = angle > 0 ? "Right" : "Left";
    if (a >= 152) return "Behind home plate";
    if (a >= 128) return `Dugout boxes, ${side} side`;
    if (a >= 100) return `Infield, ${side} side`;
    if (a >= 72) return `${field}-field foul pole`;
    if (a >= 48) return `${field}-field corner`;
    if (a >= 20) return `${field}-field bleachers`;
    return "Straightaway center field";
  }

  return { solarPosition, Geometry, isShaded, feelsLike, zoned, typicalConditions, plan, sections, spotName };
})();

if (typeof module !== "undefined") module.exports = ShadeEngine;
