#!/usr/bin/env node
/*
 * Lindquist Hub — baker
 * Reads iCal calendar feeds + live weather, renders a static index.html for the wall iPad.
 * Runs in GitHub Actions on a schedule; writes to ./_site. No personal data is stored in
 * the repo — calendar feed URLs come from encrypted secrets (env vars) at build time only.
 *
 * Testing locally: point an env var at a local .ics file instead of a URL, e.g.
 *   CAL_MAIN_ICS=./sample.ics node scripts/build.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ical = require('node-ical');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const TZ_OFFSET_MIN = 600; // Australia/Brisbane = UTC+10, no daylight saving (fixed)

const config = readJSON(path.join(ROOT, 'config.json'));
const quips = readJSON(path.join(ROOT, 'data', 'quips.json'));

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

/* ---------- Brisbane time helpers (fixed +10, no DST) ---------- */
// Given an absolute instant (Date), return its Brisbane wall-clock parts.
function bris(instant) {
  const shifted = new Date(instant.getTime() + TZ_OFFSET_MIN * 60000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    dow: shifted.getUTCDay()
  };
}
// Brisbane midnight (as an absolute instant) for the given y/m/d.
function brisMidnight(y, m, d) {
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - TZ_OFFSET_MIN * 60000);
}
function dayKey(p) { return p.y + '-' + pad(p.m + 1) + '-' + pad(p.d); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
// Read a floating date's UTC fields directly (its UTC fields ARE the Brisbane wall time).
function utcKey(dt) { return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()); }
function partsUTC(dt) {
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), hh: dt.getUTCHours(), mm: dt.getUTCMinutes(), dow: dt.getUTCDay() };
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ---------- range: today 00:00 Brisbane .. +14 days ---------- */
const nowParts = bris(new Date());
const rangeStart = brisMidnight(nowParts.y, nowParts.m, nowParts.d);
const rangeEnd = new Date(rangeStart.getTime() + 14 * 86400000);
const todayKey = dayKey(nowParts);
// Floating range (Brisbane wall-time written as UTC) for rrule.between(),
// which returns floating dates whose UTC fields equal the local wall time.
const rangeStartFloat = new Date(Date.UTC(nowParts.y, nowParts.m, nowParts.d, 0, 0, 0));
const rangeEndFloat = new Date(rangeStartFloat.getTime() + 14 * 86400000);

/* ---------- load + parse one feed ---------- */
async function loadFeed(src) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) {
    return await ical.async.fromURL(src);
  }
  return ical.sync.parseICS(fs.readFileSync(src, 'utf8'));
}

/* ---------- expand a VEVENT into occurrences for the display fortnight ----------
 * node-ical quirk: for recurring events, rrule.between() returns "floating" dates
 * whose UTC fields already equal the Brisbane wall-clock time, while one-off .start
 * values and EXDATE / override values are true instants. So recurring occurrences
 * read their parts straight off the UTC fields; instants go through bris(). */
function occurrences(ev) {
  const out = [];
  const allDay = ev.datetype === 'date';
  if (!ev.rrule) {
    if (ev.start >= rangeStart && ev.start < rangeEnd) {
      out.push({ parts: bris(ev.start), allDay: allDay, summary: ev.summary });
    }
    return out;
  }
  // Excluded dates and single-occurrence overrides, keyed by Brisbane date.
  const exSet = {};
  if (ev.exdate) for (const k in ev.exdate) { const ex = ev.exdate[k]; if (ex instanceof Date) exSet[dayKey(bris(ex))] = 1; }
  const ovMap = {};
  if (ev.recurrences) for (const k in ev.recurrences) { const ov = ev.recurrences[k]; if (ov && ov.start instanceof Date) ovMap[dayKey(bris(ov.start))] = ov; }

  let dates = [];
  try { dates = ev.rrule.between(rangeStartFloat, rangeEndFloat, true); } catch (e) { dates = []; }
  for (const d of dates) {
    const key = utcKey(d); // floating date == Brisbane date
    if (exSet[key]) continue;
    if (ovMap[key]) {
      const ov = ovMap[key];
      out.push({ parts: ov.datetype === 'date' ? partsUTC(ov.start) : bris(ov.start), allDay: ov.datetype === 'date', summary: ov.summary });
      continue;
    }
    out.push({ parts: partsUTC(d), allDay: allDay, summary: ev.summary });
  }
  return out;
}

/* ---------- colour + skip + rename rules ---------- */
function skip(summary) {
  const s = summary.toLowerCase();
  return (config.skip || []).some(function (k) { return s.indexOf(k.toLowerCase()) !== -1; });
}
function colourFor(summary, dflt) {
  const s = summary.toLowerCase();
  for (const rule of (config.keywordColors || [])) {
    if (rule.match.some(function (m) { return s.indexOf(m.toLowerCase()) !== -1; })) return rule.color;
  }
  return dflt;
}
function rename(summary) {
  const s = summary.toLowerCase();
  for (const r of (config.rename || [])) {
    if (s.indexOf(r.match.toLowerCase()) !== -1) return r.to;
  }
  return summary;
}

/* ---------- time label ---------- */
function timeLabel(p) {
  let h = p.hh, ap = h < 12 ? 'AM' : 'PM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + pad(p.mm) + ' ' + ap;
}

/* ---------- weather ---------- */
async function getWeather() {
  const c = config.location;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + c.lat + '&longitude=' + c.lon +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset' +
    '&timezone=' + encodeURIComponent(c.timezone) + '&forecast_days=4';
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather fetch failed: ' + res.status);
  return await res.json();
}
function hhmm(iso) { // "2026-11-09T04:51" -> "4:51" (12h, no am/pm)
  const t = iso.split('T')[1] || '';
  let h = parseInt(t.slice(0, 2), 10); const m = t.slice(3, 5);
  if (h > 12) h -= 12; if (h === 0) h = 12;
  return h + ':' + m;
}
// WMO weather code -> one of our icon keys
function wmoIcon(code) {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'partly';
  if (code === 3 || code === 45 || code === 48) return 'cloud';
  if (code >= 95) return 'storm';
  return 'rain'; // drizzle/rain/showers/snow buckets
}
const ICONS = {
  sun: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="9" fill="#FFC845"/><g stroke="#FFC845" stroke-width="2.8" stroke-linecap="round"><path d="M24 7v4M24 37v4M7 24h4M37 24h4M12 12l3 3M33 33l3 3M36 12l-3 3M15 33l-3 3"/></g></svg>',
  partly: '<svg viewBox="0 0 48 48"><circle cx="18" cy="18" r="7" fill="#FFC845"/><g stroke="#FFC845" stroke-width="2.6" stroke-linecap="round"><path d="M18 6v3M18 27v3M6 18h3M27 18h3M9 9l2 2M27 9l-2 2"/></g><path d="M21 34a7 7 0 0 1 13-3 6 6 0 0 1-1 12H22a5.5 5.5 0 0 1-1-9z" fill="#E7EDF6"/></svg>',
  cloud: '<svg viewBox="0 0 48 48"><path d="M15 32a9 9 0 0 1 17-4 7 7 0 0 1-1 14H16a6.5 6.5 0 0 1-1-10z" fill="#DCE6F0" stroke="#8AA0B8" stroke-width="1.6"/></svg>',
  rain: '<svg viewBox="0 0 48 48"><path d="M14 28a9 9 0 0 1 17-4 7 7 0 0 1-1 14H15a6.5 6.5 0 0 1-1-10z" fill="#CFE0F2" stroke="#5BA4E6" stroke-width="1.6"/><g stroke="#5BA4E6" stroke-width="2.6" stroke-linecap="round"><path d="M18 40l-2 4M26 40l-2 4M22 41l-2 4"/></g></svg>',
  storm: '<svg viewBox="0 0 48 48"><path d="M14 26a9 9 0 0 1 17-4 7 7 0 0 1-1 14H15a6.5 6.5 0 0 1-1-10z" fill="#CFE0F2" stroke="#8AA0B8" stroke-width="1.6"/><path d="M24 28l-4 8h5l-4 8" fill="none" stroke="#E8A61E" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

/* ---------- html escaping ---------- */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---------- main ---------- */
(async function main() {
  // 1) gather events
  const events = [];
  for (const cal of config.calendars) {
    const src = process.env[cal.env];
    let data;
    try { data = await loadFeed(src); }
    catch (e) { console.error('WARN feed ' + cal.key + ' failed: ' + e.message); continue; }
    if (!data) { console.log('skip ' + cal.key + ' (no ' + cal.env + ')'); continue; }
    for (const uid in data) {
      const ev = data[uid];
      if (!ev || ev.type !== 'VEVENT' || !ev.summary) continue;
      for (const occ of occurrences(ev)) {
        if (skip(occ.summary)) continue;
        events.push({
          key: dayKey(occ.parts), parts: occ.parts, allDay: occ.allDay,
          summary: rename(occ.summary),
          colour: colourFor(occ.summary, cal.defaultColor)
        });
      }
    }
  }

  // 2) group by day
  const byDay = {};
  for (const e of events) { (byDay[e.key] = byDay[e.key] || []).push(e); }

  // 3) render two week columns (days 0-6, 7-13)
  function renderColumn(from, to) {
    let html = '';
    for (let i = from; i <= to; i++) {
      const inst = new Date(rangeStart.getTime() + i * 86400000);
      const p = bris(inst);
      const key = dayKey(p);
      const list = byDay[key];
      if (!list || !list.length) continue;
      list.sort(function (a, b) {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return (a.parts.hh * 60 + a.parts.mm) - (b.parts.hh * 60 + b.parts.mm);
      });
      const isToday = key === todayKey;
      let evHtml = '';
      for (const e of list) {
        const when = e.allDay ? 'All day' : timeLabel(e.parts);
        evHtml += '<div class="ev ' + e.colour + '"><span class="bar"></span>' +
          '<span class="txt"><span class="when">' + esc(when) + '</span>' +
          '<div class="what">' + esc(e.summary) + '</div></span></div>';
      }
      html += '<div class="day-row">' +
        '<div class="date-chip' + (isToday ? ' is-today' : '') + '">' +
        '<div class="num">' + pad(p.d) + '</div><div class="dow">' + DOW_SHORT[p.dow] + '</div></div>' +
        '<div class="events">' + evHtml + '</div></div>';
    }
    if (!html) html = '<div class="day-row"><div class="events"><div class="empty">Nothing on.</div></div></div>';
    return html;
  }
  const week1 = renderColumn(0, 6);
  const week2 = renderColumn(7, 13);

  // 4) weather
  let sunrise = '--', sunset = '--', wxCells = '';
  try {
    const w = await getWeather();
    const d = w.daily;
    sunrise = hhmm(d.sunrise[0]);
    sunset = hhmm(d.sunset[0]);
    for (let i = 0; i < 4; i++) {
      const label = i === 0 ? 'Today' : DOW_SHORT[bris(new Date(d.time[i] + 'T00:00:00+10:00')).dow];
      const icon = ICONS[wmoIcon(d.weather_code[i])];
      const hi = Math.round(d.temperature_2m_max[i]);
      const lo = Math.round(d.temperature_2m_min[i]);
      wxCells += '<div class="wx"><div class="d">' + label + '</div>' + icon +
        '<div class="t">' + hi + '°<span class="lo">/' + lo + '</span></div></div>';
    }
  } catch (e) {
    console.error('WARN weather failed: ' + e.message);
    wxCells = '<div class="wx"><div class="d">—</div><div class="t">—</div></div>';
  }

  // 5) quip of the day (deterministic by date)
  const dayNum = Math.floor(rangeStart.getTime() / 86400000);
  const q = quips[((dayNum % quips.length) + quips.length) % quips.length];
  const jokeLine = esc(q.line) + (q.punch ? '<span class="punch">' + esc(q.punch) + '</span>' : '');

  // 6) photos
  let photoList = [], photoLabel = 'Add photos to /photos';
  const photoDir = path.join(ROOT, 'photos');
  if (fs.existsSync(photoDir)) {
    photoList = fs.readdirSync(photoDir).filter(function (f) { return /\.(jpe?g|png|gif|webp)$/i.test(f); }).sort();
  }
  if (photoList.length) photoLabel = '';

  // 7) fill template
  let html = fs.readFileSync(path.join(ROOT, 'src', 'template.html'), 'utf8');
  const repl = {
    '__REFRESH__': String((config.refreshMinutes || 30) * 60),
    '__DOW__': DOW_LONG[nowParts.dow],
    '__FULLDATE__': nowParts.d + ' ' + MONTHS[nowParts.m] + ' ' + nowParts.y,
    '__SUNRISE__': sunrise,
    '__SUNSET__': sunset,
    '__WX_CELLS__': wxCells,
    '__WEEK1__': week1,
    '__WEEK2__': week2,
    '__JOKE_TAG__': esc(q.tag),
    '__JOKE_LINE__': jokeLine,
    '__PHOTO_LABEL__': esc(photoLabel),
    '__PHOTO_LIST__': JSON.stringify(photoList),
    '__PHOTO_MS__': String((config.photoSeconds || 20) * 1000)
  };
  for (const k in repl) { html = html.split(k).join(repl[k]); }

  // 8) write _site
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  if (photoList.length) {
    const outPhotos = path.join(OUT, 'photos');
    if (!fs.existsSync(outPhotos)) fs.mkdirSync(outPhotos, { recursive: true });
    for (const f of photoList) fs.copyFileSync(path.join(photoDir, f), path.join(outPhotos, f));
  }
  console.log('Built _site/index.html — ' + events.length + ' events, ' + photoList.length + ' photos.');
})().catch(function (e) { console.error(e); process.exit(1); });
