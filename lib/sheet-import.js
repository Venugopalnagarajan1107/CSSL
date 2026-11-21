'use strict';
/* Reads player lists from any Excel workbook: finds the header row on each sheet,
   maps columns by their header text (not position) and decodes common formats. */

const FIELDS = [
  { key: 'name', label: 'Name', aliases: ['name', 'full name', 'player name', 'player', 'participant name', 'participant', 'student name', 'student', 'employee name', 'employee', 'member name', 'candidate name'] },
  { key: 'firstName', label: 'First name', aliases: ['first name', 'firstname', 'given name'] },
  { key: 'lastName', label: 'Last name', aliases: ['last name', 'lastname', 'surname', 'family name'] },
  { key: 'section', label: 'Section (adults/kids)', aliases: ['section', 'division', 'adults kids', 'adult kid', 'adult child'] },
  { key: 'gender', label: 'Gender', aliases: ['gender', 'sex', 'm f', 'male female'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'mobile', 'cell', 'contact', 'whatsapp', 'ph', 'tel', 'telephone'] },
  { key: 'email', label: 'Email', aliases: ['email', 'e mail', 'mail', 'email id', 'mail id'] },
  { key: 'dob', label: 'Date of birth', aliases: ['date of birth', 'dob', 'd o b', 'birth date', 'birthdate', 'birthday', 'born'] },
  { key: 'ageGroup', label: 'Age group', aliases: ['age group', 'age category', 'age', 'category', 'under'] },
  { key: 'affiliation', label: 'Department / company', aliases: ['department', 'dept', 'company', 'organisation', 'organization', 'org', 'school', 'club', 'affiliation', 'institute', 'college', 'office', 'unit', 'branch'] },
  { key: 'games', label: 'Games (event names)', aliases: ['games', 'game', 'events', 'event', 'sports', 'sport', 'event name', 'events played', 'participating in', 'registered for'] },
  { key: 'team', label: 'Team', aliases: ['team', 'team name', 'squad'] },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

const norm = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return isNaN(v) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('').trim();
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('hyperlink' in v) return String(v.hyperlink).replace(/^mailto:/i, '').trim();
    return '';
  }
  return String(v).trim();
}

/* Which field a header belongs to ('' = none). Longest alias wins, so "team name" beats "name". */
const ALIASES = FIELDS.flatMap((f) => f.aliases.map((a) => ({ a, key: f.key }))).sort((x, y) => y.a.length - x.a.length);
function fieldFor(header) {
  const h = norm(header); if (!h) return '';
  const idLike = /\b(id|no|nos|number|num|code|count|type|size|photo|signature)$/.test(h);
  for (const { a, key } of ALIASES) {
    if (!(h === a || h.startsWith(a + ' '))) continue;
    if (h !== a && idLike && !['phone', 'email', 'dob'].includes(key)) continue;   // "Player ID", "Team No" are not names
    return key;
  }
  if (idLike) return '';
  if (/\bname\b/.test(h) && !/\b(event|team|guardian|parent|father|mother|school|company|club)\b/.test(h)) return 'name';
  return '';
}

/* Event whose name matches a piece of text (exact, then ignoring spaces/punctuation). */
function eventByName(text, events, section) {
  const t = String(text || '').trim().toLowerCase(), q = squash(t); if (!q) return null;
  const pick = (list) => (section && list.find((e) => (e.section || 'adults') === section)) || list[0] || null;
  return pick(events.filter((e) => e.name.toLowerCase() === t)) || pick(events.filter((e) => squash(e.name) === q));
}

/* Guess the event a whole sheet is about from the sheet name (e.g. sheet "Chess"). */
function eventForSheet(sheetName, events) {
  const exact = eventByName(sheetName, events); if (exact) return exact;
  const q = squash(sheetName); if (q.length < 3) return null;
  const hits = events.filter((e) => squash(e.name).includes(q) || q.includes(squash(e.name)));
  return hits.length === 1 ? hits[0] : null;
}

function rowValues(ws, r) {
  const row = ws.getRow(r), out = [];
  for (let c = 1; c <= Math.min(ws.columnCount || 0, 60); c++) out[c] = cellText(row.getCell(c).value);
  return out;
}

/* Find the header row (first 15 rows) and map its columns. */
function inspectSheet(ws, events) {
  let best = null;
  for (let r = 1; r <= Math.min(ws.rowCount || 0, 15); r++) {
    const vals = rowValues(ws, r), map = {}, used = {};
    vals.forEach((v, c) => { const k = fieldFor(v); if (k && !(k in map)) { map[k] = c; used[c] = 1; } });
    const evCols = [];
    vals.forEach((v, c) => { if (!used[c] && v) { const e = eventByName(v, events); if (e) evCols.push({ col: c, eventId: e.id, eventName: e.name }); } });
    const score = Object.keys(map).length + evCols.length + (map.name || map.firstName ? 5 : 0);
    if (!best || score > best.score) best = { score, headerRow: r, map, evCols, vals };
    if (map.name && Object.keys(map).length >= 2) break;
  }
  const headers = best ? best.vals.map((text, col) => ({ col, text })).filter((x) => x && x.text) : [];
  const map = best ? best.map : {};
  const hasName = !!(map.name || map.firstName);
  const ev = eventForSheet(ws.name, events);
  const info = {
    name: ws.name, headerRow: best ? best.headerRow : 1, headers, map, eventCols: best ? best.evCols : [],
    looksLikePlayers: hasName, eventId: ev ? ev.id : '', section: /kid|junior|child|under|u\s?\d\d/i.test(ws.name) ? 'kids' : '',
  };
  const rows = hasName ? readRows(ws, info, events) : [];
  info.rows = rows.length; info.sample = rows.slice(0, 3).map((x) => x.name);
  if (!hasName) info.reason = headers.length ? 'No name column found' : 'Empty sheet';
  return info;
}

const truthy = (v) => v !== '' && !/^(no|n|0|false|-|x?no|nil|na|n\/a)$/i.test(v);
function toDob(v) {
  const s = String(v || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Math.round((Number(s) - 25569) * 864e5)); if (!isNaN(d)) return d.toISOString().slice(0, 10); }
  return '';
}
const toGender = (v) => { const s = String(v || '').trim().toLowerCase(); return /^(m|male|man|boy|gents?)$/.test(s) ? 'M' : /^(f|female|woman|girl|ladies|lady)$/.test(s) ? 'F' : ''; };

/* Rows of one sheet as plain player records. opts: { headerRow, map, eventCols, eventId, section } */
function readRows(ws, opts, events) {
  const out = [], map = opts.map || {};
  const get = (vals, k) => (map[k] ? vals[map[k]] || '' : '');
  for (let r = (opts.headerRow || 1) + 1; r <= Math.min(ws.rowCount || 0, 2000); r++) {
    const vals = rowValues(ws, r);
    const name = (get(vals, 'name') || [get(vals, 'firstName'), get(vals, 'lastName')].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
    if (!name || /^\d+$/.test(name)) continue;
    const secTxt = get(vals, 'section');
    const section = secTxt ? (/kid|child|junior|under|u\s?\d/i.test(secTxt) ? 'kids' : 'adults') : opts.section || 'adults';
    const games = get(vals, 'games').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
    (opts.eventCols || []).forEach((ec) => { if (truthy(vals[ec.col] || '')) games.push(ec.eventName); });
    let fromSheet = false;
    if (!games.length && opts.eventId) { const e = events.find((x) => x.id === opts.eventId); if (e) { games.push(e.name); fromSheet = true; } }
    out.push({
      row: r, name, section, gender: toGender(get(vals, 'gender')), phone: get(vals, 'phone'), email: get(vals, 'email'),
      dob: toDob(get(vals, 'dob')), ageGroup: get(vals, 'ageGroup'), affiliation: get(vals, 'affiliation'), games, fromSheet, team: get(vals, 'team'),
    });
  }
  return out;
}

module.exports = { FIELDS, FIELD_KEYS, inspectSheet, readRows, eventByName, cellText, fieldFor };
