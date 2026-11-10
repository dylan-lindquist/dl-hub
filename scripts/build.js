#!/usr/bin/env node
/*
 * Lindquist Hub — baker
 * Static family wall-dashboard for an old iPad (iOS 9 Safari). Runs in GitHub Actions
 * twice a day. Reads iCal calendar feeds + live weather + a few content feeds and writes
 * ./_site/index.html. No personal data in the repo — feed URLs come from encrypted secrets.
 *
 * Local test: CAL_MAIN_ICS=./sample.ics node scripts/build.js  (feeds fall back to data/*.json)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ical = require('node-ical');
const { RRule } = require('rrule');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const TZ = 600; // Australia/Brisbane = UTC+10, fixed (no DST)

const config = readJSON(path.join(ROOT, 'config.json'));
function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function readData(name) { try { return readJSON(path.join(ROOT, 'data', name)); } catch (e) { return []; } }

/* ---------- Brisbane time (fixed +10) ---------- */
function bris(instant) {
  const s = new Date(instant.getTime() + TZ * 60000);
  return { y: s.getUTCFullYear(), m: s.getUTCMonth(), d: s.getUTCDate(), hh: s.getUTCHours(), mm: s.getUTCMinutes(), dow: s.getUTCDay() };
}
function partsUTC(dt) { return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate(), hh: dt.getUTCHours(), mm: dt.getUTCMinutes(), dow: dt.getUTCDay() }; }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function dayKey(p) { return p.y + '-' + pad(p.m + 1) + '-' + pad(p.d); }
function utcKey(dt) { return dt.getUTCFullYear() + '-' + pad(dt.getUTCMonth() + 1) + '-' + pad(dt.getUTCDate()); }

const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const now = new Date();
const nowP = bris(now);
const todayKey = dayKey(nowP);
// True-instant range (for one-off events) and floating range (for recurrence expansion).
const rangeStart = new Date(Date.UTC(nowP.y, nowP.m, nowP.d, 0, 0, 0) - TZ * 60000);
const rangeEnd = new Date(rangeStart.getTime() + 14 * 86400000);
const rangeStartFloat = new Date(Date.UTC(nowP.y, nowP.m, nowP.d, 0, 0, 0));
const rangeEndFloat = new Date(rangeStartFloat.getTime() + 14 * 86400000);

/* ---------- feed loading ---------- */
async function loadFeed(src) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return await ical.async.fromURL(src);
  return ical.sync.parseICS(fs.readFileSync(src, 'utf8'));
}

/* ---------- recurrence expansion ----------
 * Google feeds encode recurring events inconsistently (TZID vs UTC), which makes
 * node-ical's rrule.between() return times that are sometimes floating, sometimes true
 * instants — the cause of the "8am shows as 10pm" bug. Fix: ignore the original rrule's
 * clock entirely. Take the correct Brisbane wall-time from the resolved .start instant,
 * rebuild the rule on a clean floating-Brisbane dtstart, and expand in that frame. Robust
 * to both encodings because Brisbane has no daylight saving. */
function occurrences(ev) {
  const out = [];
  const allDay = ev.datetype === 'date';
  if (!ev.rrule) {
    if (ev.start >= rangeStart && ev.start < rangeEnd) out.push({ parts: bris(ev.start), allDay: allDay, summary: ev.summary });
    return out;
  }
  const sb = bris(ev.start);
  const floatStart = new Date(Date.UTC(sb.y, sb.m, sb.d, allDay ? 0 : sb.hh, allDay ? 0 : sb.mm, 0));
  const opts = Object.assign({}, ev.rrule.origOptions || ev.rrule.options);
  delete opts.tzid;        // expand timezone-naive; floatStart already carries Brisbane wall time
  opts.dtstart = floatStart;
  if (opts.until) { const ub = bris(new Date(opts.until)); opts.until = new Date(Date.UTC(ub.y, ub.m, ub.d, 23, 59, 0)); }
  let dates = [];
  try { dates = new RRule(opts).between(rangeStartFloat, rangeEndFloat, true); } catch (e) { return out; }

  const exSet = {};
  if (ev.exdate) for (const k in ev.exdate) { const ex = ev.exdate[k]; if (ex instanceof Date) exSet[dayKey(bris(ex))] = 1; }
  const ovMap = {};
  if (ev.recurrences) for (const k in ev.recurrences) { const ov = ev.recurrences[k]; if (ov && ov.start instanceof Date) ovMap[dayKey(bris(ov.start))] = ov; }

  for (const d of dates) {
    const key = utcKey(d);
    if (exSet[key]) continue;
    if (ovMap[key]) { const ov = ovMap[key]; out.push({ parts: ov.datetype === 'date' ? partsUTC(ov.start) : bris(ov.start), allDay: ov.datetype === 'date', summary: ov.summary }); continue; }
    out.push({ parts: partsUTC(d), allDay: allDay, summary: ev.summary });
  }
  return out;
}

function skip(s) { s = s.toLowerCase(); return (config.skip || []).some(function (k) { return s.indexOf(k.toLowerCase()) !== -1; }); }
function rename(s) { const l = s.toLowerCase(); for (const r of (config.rename || [])) { if (l.indexOf(r.match.toLowerCase()) !== -1) return r.to; } return s; }
function timeLabel(p) { let h = p.hh, ap = h < 12 ? 'AM' : 'PM'; h = h % 12; if (h === 0) h = 12; return h + ':' + pad(p.mm) + ' ' + ap; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/* ---------- weather (line icons) ---------- */
const CLOUD = 'M8 15a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1A3.8 3.8 0 0 1 17.5 15z';
function wxSvg(inner) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>'; }
const ICONS = {
  sun: wxSvg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12h2.5M19 12h2.5M5.1 5.1l1.8 1.8M17.1 17.1l1.8 1.8M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8"/>'),
  partly: wxSvg('<circle cx="8.5" cy="8" r="3"/><path d="M8.5 2.5v1.6M3.5 8H2M4.6 4.1l1.1 1.1M12.4 4.1l-1.1 1.1"/><path d="M8 18.5a3.7 3.7 0 0 1-.4-7.37 5 5 0 0 1 9.6-.4A3.5 3.5 0 0 1 16.5 18.5z"/>'),
  cloud: wxSvg('<path d="M8 17a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1A3.8 3.8 0 0 1 17.5 17z"/>'),
  rain: wxSvg('<path d="' + CLOUD + '"/><path d="M9 17.5l-1 2.5M13 17.5l-1 2.5M16.8 17.5l-1 2.5"/>'),
  heavy: wxSvg('<path d="' + CLOUD + '"/><path d="M8 17.5l-1.2 3M11.3 17.5l-1.2 3M14.6 17.5l-1.2 3M17.2 17.5l-1.2 3"/>'),
  storm: wxSvg('<path d="' + CLOUD + '"/><path d="M12.5 12.5l-2.5 4h2.5L10 21"/>'),
  fog: wxSvg('<path d="M8 13a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1A3.8 3.8 0 0 1 17.5 13z"/><path d="M5 17h14M7 20h10"/>'),
  wind: wxSvg('<path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5M3 12h15a2.5 2.5 0 1 1-2.5 2.5M4 16h8a2 2 0 1 1-2 2"/>')
};
function wmoIcon(c) {
  if (c === 0 || c === 1) return 'sun';
  if (c === 2) return 'partly';
  if (c === 3) return 'cloud';
  if (c === 45 || c === 48) return 'fog';
  if (c === 65 || c === 66 || c === 67 || c === 82 || c === 99) return 'heavy';
  if (c >= 95) return 'storm';
  return 'rain';
}
function hhmm(iso) { const t = (iso.split('T')[1] || ''); let h = parseInt(t.slice(0, 2), 10); const m = t.slice(3, 5); if (h > 12) h -= 12; if (h === 0) h = 12; return h + ':' + m; }
async function getWeather() {
  const c = config.location;
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + c.lat + '&longitude=' + c.lon +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=' + encodeURIComponent(c.timezone) + '&forecast_days=4';
  const r = await fetch(url); if (!r.ok) throw new Error('weather ' + r.status); return await r.json();
}

/* ---------- content feeds (each falls back to data/*.json, picked by date) ---------- */
const dayIndex = Math.floor(rangeStartFloat.getTime() / 86400000);
function pick(list) { return (list && list.length) ? list[((dayIndex % list.length) + list.length) % list.length] : null; }
function clean(s) { return String(s).replace(/`/g, "'").replace(/\s+/g, ' ').trim(); }
function stripTags(s) { return s.replace(/<[^>]*>/g, ' ').replace(/&lt;[^&]*&gt;/g, ' '); }
function decode(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' '); }

async function getWord() {
  try {
    const r = await fetch('https://www.merriam-webster.com/wotd/feed/rss2'); if (!r.ok) throw 0;
    const xml = await r.text();
    const item = xml.split('<item>')[1] || '';
    const word = clean(decode((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ''));
    let desc = decode((item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    desc = clean(stripTags(desc));
    const sentence = (desc.split(/(?<=\.)\s/)[0] || desc).slice(0, 150);
    if (word && sentence) return { word: word, def: sentence };
    throw 0;
  } catch (e) { const f = pick(readData('words.json')); return f || { word: 'Petrichor', def: 'The earthy smell after rain on dry ground.' }; }
}
async function getFact() {
  try { const r = await fetch('https://uselessfacts.jsph.pl/api/v2/facts/today'); if (!r.ok) throw 0; const j = await r.json(); const t = clean(j.text || ''); if (t) return t; throw 0; }
  catch (e) { return pick(readData('facts.json')) || 'Octopuses have three hearts and blue blood.'; }
}
async function getRiddle() {
  try { const r = await fetch('https://riddles-api.vercel.app/random'); if (!r.ok) throw 0; const j = await r.json(); const q = clean(j.riddle || ''); if (q) return q; throw 0; }
  catch (e) { return pick(readData('riddles.json')) || 'What has to be broken before you can use it?'; }
}
async function getJoke() {
  try { const r = await fetch('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json', 'User-Agent': 'Lindquist Hub (github static board)' } }); if (!r.ok) throw 0; const j = await r.json(); const t = clean(j.joke || ''); if (t) return t; throw 0; }
  catch (e) { return pick(readData('jokes.json')) || 'Why did the scarecrow win an award? Because he was outstanding in his field.'; }
}

/* ---------- grid cell ---------- */
const MAXEV = config.maxEventsPerDay || 3;
function renderCell(dateInst, byDay, opts) {
  const p = bris(dateInst);
  const key = dayKey(p);
  const list = (byDay[key] || []).slice();
  list.sort(function (a, b) { if (a.allDay !== b.allDay) return a.allDay ? -1 : 1; return (a.parts.hh * 60 + a.parts.mm) - (b.parts.hh * 60 + b.parts.mm); });
  let evs = '';
  const shown = list.slice(0, MAXEV);
  for (const e of shown) {
    if (e.allDay) evs += '<div class="ev allday"><div class="n">' + esc(e.summary) + '</div></div>';
    else evs += '<div class="ev"><div class="t">' + esc(timeLabel(e.parts)) + '</div><div class="n">' + esc(e.summary) + '</div></div>';
  }
  if (list.length > MAXEV) evs += '<div class="more">+' + (list.length - MAXEV) + ' more</div>';
  const cls = 'cellbox' + (opts.wrap ? ' wrap' : '') + (opts.today ? ' today' : '');
  return '<div class="cell"><div class="' + cls + '"><div class="daynum"><span class="d">' + pad(p.d) + '</span></div><div class="evs">' + evs + '</div></div></div>';
}

/* ---------- main ---------- */
(async function main() {
  // 1) events
  const events = [];
  for (const cal of config.calendars) {
    let data;
    try { data = await loadFeed(process.env[cal.env]); } catch (e) { console.error('WARN feed ' + cal.key + ': ' + e.message); continue; }
    if (!data) { console.log('skip ' + cal.key + ' (no ' + cal.env + ')'); continue; }
    for (const uid in data) {
      const ev = data[uid];
      if (!ev || ev.type !== 'VEVENT' || !ev.summary) continue;
      for (const occ of occurrences(ev)) { if (!skip(occ.summary)) events.push({ key: dayKey(occ.parts), parts: occ.parts, allDay: occ.allDay, summary: rename(occ.summary) }); }
    }
  }
  const byDay = {};
  for (const e of events) (byDay[e.key] = byDay[e.key] || []).push(e);

  // 2) grid — rolling 7x2 window, today's week on top, tail days wrapped into empty slots
  const windowDay = function (off) { return new Date(rangeStart.getTime() + off * 86400000); };
  const todayDOW = nowP.dow;
  let row1 = '', row2 = '';
  for (let c = 0; c < 7; c++) {
    const o1 = ((c - todayDOW) % 7 + 7) % 7; // first window day on this weekday (0..6)
    const o2 = o1 + 7;                        // second (7..13)
    const isPast = c < todayDOW;              // weekday earlier than today this week
    const topOff = isPast ? o2 : o1;
    const botOff = isPast ? o1 : o2;
    row1 += renderCell(windowDay(topOff), byDay, { wrap: isPast, today: topOff === 0 });
    row2 += renderCell(windowDay(botOff), byDay, { wrap: false, today: false });
  }

  // 3) weather
  let sunrise = '--', sunset = '--', wxCells = '';
  try {
    const w = await getWeather(); const d = w.daily;
    sunrise = hhmm(d.sunrise[0]); sunset = hhmm(d.sunset[0]);
    const lbl = ['Today'];
    for (let i = 1; i < 4; i++) lbl.push(DOW_LONG[bris(new Date(d.time[i] + 'T00:00:00+10:00')).dow].slice(0, 3));
    for (let i = 0; i < 4; i++) {
      wxCells += '<div class="wx"><div class="d">' + lbl[i] + '</div>' + ICONS[wmoIcon(d.weather_code[i])] +
        '<div class="t">' + Math.round(d.temperature_2m_max[i]) + '°<span class="lo">/' + Math.round(d.temperature_2m_min[i]) + '°</span></div></div>';
    }
  } catch (e) { console.error('WARN weather: ' + e.message); wxCells = '<div class="wx"><div class="d">—</div><div class="t">—</div></div>'; }

  // 4) bottom cards — weekend = riddle; weekday = word (AM) + fact (PM), flipped client-side
  const isWeekend = (todayDOW === 0 || todayDOW === 6);
  let leftCard;
  if (isWeekend) {
    const riddle = await getRiddle();
    leftCard = '<div class="tag">Riddle</div><div class="line">' + esc(riddle) + '</div>';
  } else {
    const word = await getWord(); const fact = await getFact();
    leftCard = '<div class="tag" id="amtag">Word of the day</div>' +
      '<div class="line" id="amline">' + esc(word.word) + '<span class="sub">' + esc(word.def) + '</span></div>' +
      '<div class="tag" id="pmtag" hidden>Did you know?</div>' +
      '<div class="line" id="pmline" hidden>' + esc(fact) + '</div>';
  }
  const joke = await getJoke();

  // 5) fill template
  let html = fs.readFileSync(path.join(ROOT, 'src', 'template.html'), 'utf8');
  const repl = {
    '__REFRESH__': String((config.refreshMinutes || 30) * 60),
    '__DOW__': DOW_LONG[nowP.dow],
    '__FULLDATE__': nowP.d + ' ' + MONTHS[nowP.m] + ' ' + nowP.y,
    '__SUNRISE__': sunrise, '__SUNSET__': sunset,
    '__WX_CELLS__': wxCells, '__ROW1__': row1, '__ROW2__': row2,
    '__LEFTCARD__': leftCard, '__JOKE__': esc(joke)
  };
  for (const k in repl) html = html.split(k).join(repl[k]);

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'index.html'), html);
  console.log('Built _site/index.html — ' + events.length + ' events, ' + (isWeekend ? 'weekend/riddle' : 'weekday/word+fact') + '.');
})().catch(function (e) { console.error(e); process.exit(1); });
