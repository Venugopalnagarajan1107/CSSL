'use strict';
/* Reads player lists from any Excel workbook: finds the header row on each sheet,
   maps columns by their header text (not position) and decodes common formats. */

const FIELDS = [
  { key: 'name', label: 'Name', aliases: ['name', 'full name', 'player name', 'player', 'participant name', 'participant', 'student name', 'student', 'employee name', 'employee', 'member name', 'candidate name'] },
  { key: 'firstName', label: 'First name', aliases: ['first name', 'firstname', 'given name'] },
  { key: 'lastName', label: 'Last name', aliases: ['last name', 'lastname', 'surname', 'family name'] },
  { key: 'section', label: 'Section / category (adults/kids)', aliases: ['section', 'division', 'category', 'adults kids', 'adult kid', 'adult child', 'seniors juniors'] },
  { key: 'gender', label: 'Gender', aliases: ['gender', 'sex', 'm f', 'male female'] },
  { key: 'phone', label: 'Phone', aliases: ['phone', 'mobile', 'cell', 'contact', 'whatsapp', 'ph', 'tel', 'telephone'] },
  { key: 'email', label: 'Email', aliases: ['email', 'e mail', 'mail', 'email id', 'mail id'] },
  { key: 'dob', label: 'Date of birth', aliases: ['date of birth', 'dob', 'd o b', 'birth date', 'birthdate', 'birthday', 'born'] },
  { key: 'ageGroup', label: 'Age group', aliases: ['age group', 'age category', 'under'] },
  { key: 'age', label: 'Age (years)', aliases: ['age', 'age in years', 'age years', 'current age'] },
  { key: 'villa', label: 'Villa / flat / house no.', aliases: ['villa', 'villa no', 'villa number', 'flat', 'flat no', 'flat number', 'house', 'house no', 'house number', 'apartment', 'apt', 'door no', 'block'] },
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
  if (/^(player|member|side|team|participant)\s*(\d+|a|b)$/.test(h)) return '';   // "Player 1", "Team A": team members / fixture sides
  const idLike = /\b(id|no|nos|number|num|code|count|type|size|photo|signature)$/.test(h);
  for (const { a, key } of ALIASES) {
    if (!(h === a || h.startsWith(a + ' '))) continue;
    if (h !== a && idLike && !['phone', 'email', 'dob', 'villa'].includes(key)) continue;   // "Player ID", "Team No" are not names
    return key;
  }
  if (idLike) return '';
  if (/\bname\b/.test(h) && !/\b(event|team|guardian|parent|father|mother|school|company|club)\b/.test(h)) return 'name';
  return '';
}

/* A column that is about one sport, e.g. "Select Games to Participate [Badminton]" or just "Chess". */
const SPORT_WORDS = [['badminton', /badminton|shuttle/], ['tt', /table\s*tennis|ping\s*pong|\btt\b/], ['carrom', /carrom/], ['chess', /chess/]];
function sportOfHeader(header) {
  const raw = String(header || ''), inner = (raw.match(/[[(]([^\])]+)[\])]/) || [])[1];
  const look = (t) => { const hits = SPORT_WORDS.filter(([, re]) => re.test(String(t).toLowerCase())); return hits.length === 1 ? hits[0][0] : ''; };
  if (inner && look(inner)) return look(inner);
  const n = norm(raw);
  if (SPORT_WORDS.some(([k, re]) => re.test(n) && n.replace(re, '').trim() === '')) return look(n);   // header is just the sport name
  if (/\b(game|games|sport|sports|participat|play|event|events|interested|register)/.test(n)) return look(n);
  return '';
}

const FEMALE = /\b(women|woman|womens|ladies|lady|girls?|female)\b/i, MALE = /\b(men|mens|gents|boys?|male)\b/i;
/* Which game a "Yes" in a sport column means for this player: same sport and section, fits gender and age;
   individual games first, team games after (the player then goes on that game's interested list). */
function eventForSport(sport, p, events, override) {
  if (override === 'skip') return null;
  if (override) return events.find((e) => e.id === override) || null;
  const age = (() => { const t = String(p.ageGroup || ''); let m = t.match(/\b(?:under|u)[-\s]?(\d{1,2})\b/i); if (m) return Number(m[1]) - 1; m = t.match(/\d{1,2}/); return m ? Number(m[0]) : null; })();
  const fits = events.filter((e) => e.sport === sport && (e.section || 'adults') === p.section)
    .filter((e) => !(p.gender === 'M' && FEMALE.test(e.name) && !MALE.test(e.name)) && !(p.gender === 'F' && MALE.test(e.name) && !FEMALE.test(e.name)))
    .filter((e) => age == null || ((!e.ageMin || age >= e.ageMin) && (!e.ageMax || age <= e.ageMax)));
  return fits.find((e) => e.sideType !== 'team') || fits[0] || null;
}

/* "ARJUN K RAO" / "m s priya" -> "Arjun K Rao" / "M S Priya"; mixed case is left alone. */
function tidyName(n) {
  const s = String(n || '').replace(/\s+/g, ' ').trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) return s.split(' ').map((w) => (/^[a-z]/.test(w) && w === w.toLowerCase() ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (x, a, b) => a + b.toUpperCase());
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
    const evCols = [], sportCols = [];
    vals.forEach((v, c) => {
      if (used[c] || !v) return;
      const e = eventByName(v, events); if (e) { evCols.push({ col: c, eventId: e.id, eventName: e.name }); return; }
      const sp = sportOfHeader(v); if (sp) sportCols.push({ col: c, sport: sp, header: v });
    });
    const score = Object.keys(map).length + evCols.length + sportCols.length + (map.name || map.firstName ? 5 : 0);
    if (!best || score > best.score) best = { score, headerRow: r, map, evCols, sportCols, vals };
    if (map.name && Object.keys(map).length >= 2) break;
  }
  const headers = best ? best.vals.map((text, col) => ({ col, text })).filter((x) => x && x.text) : [];
  const map = best ? best.map : {};
  const hasName = !!(map.name || map.firstName);
  const ev = eventForSheet(ws.name, events);
  const info = {
    name: ws.name, headerRow: best ? best.headerRow : 1, headers, map, eventCols: best ? best.evCols : [], sportCols: best ? best.sportCols : [],
    looksLikePlayers: hasName, eventId: ev ? ev.id : '', section: /kid|junior|child|under|u\s?\d\d/i.test(ws.name) ? 'kids' : '',
  };
  const rows = hasName ? readRows(ws, info, events) : [];
  info.rows = rows.length; info.sample = rows.slice(0, 3).map((x) => x.name);
  if (!hasName) info.reason = headers.length ? 'No name column found' : 'Empty sheet';
  const k = sheetKind(ws, events);
  info.kind = k.kind !== 'other' ? k.kind : hasName ? 'players' : 'other';
  info.kindCols = k.cols; info.kindHeaderRow = k.headerRow;
  if (info.kind === 'games') info.rows = readGames(ws, k.headerRow, k.cols).length;
  if (info.kind === 'teams') info.rows = readTeams(ws, k.headerRow, k.cols).length;
  if (info.kind === 'fixtures') info.rows = readFixtures(ws, k.headerRow, k.cols).length;
  if (info.kind !== 'players') info.looksLikePlayers = false;
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

/* ------------------------------------------------------------------------------------------------
   Other sheet kinds in the same workbook: games, teams and fixtures. Recognised by their headers. */
const KIND_COLS = {
  games: { name: /^(game|event|competition|game name|event name|name of (the )?(game|event))$/, sport: /^sport/, section: /^(section|category|division|adults kids)$/, type: /^(type|who plays|format|play type|singles doubles|singles doubles team|mode)$/, bestOf: /^best of/, target: /^(points per game|points|target|game points)$/ },
  teams: { team: /^(team|team name|name of (the )?team)$/, section: /^(section|category|division)$/, games: /^(game|games|event|events|plays in|tournament)$/, members: /^(members|players|team members|squad|line up|lineup)$/, member: /^(player|member)\s*\d+$/ },
  fixtures: { game: /^(game|event|competition)$/, a: /^((side|team|player|home)\s*(a|1)|home|side 1)$/, b: /^((side|team|player|away)\s*(b|2)|away|opponent|side 2)$/, stage: /^(stage|round|phase)$/, group: /^(group|pool)$/, date: /^(date|day|match date)$/, time: /^(time|start|start time|slot|match time)$/, when: /^(date (and|&)? ?time|date time|when|starts at)$/, court: /^(court|table|board|venue|location)$/, referee: /^(referee|umpire|official)$/, score: /^(score|scores|result|set scores|game scores)$/ },
};
function kindColumns(vals, kind) {
  const out = {}, spec = KIND_COLS[kind];
  vals.forEach((v, c) => { const n = norm(v); if (!n) return; Object.entries(spec).forEach(([k, re]) => { if (k === 'member') { if (re.test(n)) (out.member = out.member || []).push(c); } else if (!(k in out) && re.test(n)) out[k] = c; }); });
  return out;
}
/* Best guess of what a sheet holds, from its header row. */
function sheetKind(ws) {
  let best = { kind: 'other', headerRow: 1, cols: {} };
  for (let r = 1; r <= Math.min(ws.rowCount || 0, 15); r++) {
    const vals = rowValues(ws, r);
    const fx = kindColumns(vals, 'fixtures'), tm = kindColumns(vals, 'teams'), gm = kindColumns(vals, 'games');
    if (tm.team && (tm.members || (tm.member || []).length >= 2)) return { kind: 'teams', headerRow: r, cols: tm };
    if (fx.a && fx.b) return { kind: 'fixtures', headerRow: r, cols: fx };
    if (gm.name && (gm.sport || gm.type) && !vals.some((v) => fieldFor(v) === 'phone')) return { kind: 'games', headerRow: r, cols: gm };
  }
  return best;
}
const splitNames = (t) => String(t || '').split(/\s*(?:[,;\n/+&]|\band\b)\s*/i).map((x) => x.trim()).filter(Boolean);
function rawCell(ws, r, c) { return c ? ws.getRow(r).getCell(c).value : null; }
function readGames(ws, headerRow, cols) {
  const out = [];
  for (let r = headerRow + 1; r <= Math.min(ws.rowCount || 0, 500); r++) {
    const vals = rowValues(ws, r), g = (k) => (cols[k] ? vals[cols[k]] || '' : '');
    const name = g('name').replace(/\s+/g, ' ').trim(); if (!name) continue;
    const sp = SPORT_WORDS.find(([, re]) => re.test((g('sport') || name).toLowerCase()));
    const type = g('type').toLowerCase(), sec = g('section');
    out.push({ row: r, name, sport: sp ? sp[0] : 'other', section: /kid|child|junior|under|u\s?\d/i.test(sec) ? 'kids' : 'adults',
      sideType: /team/.test(type) ? 'team' : 'player', sideSize: /doubles|pair|2/.test(type) ? 2 : 1, bestOf: Number(g('bestOf')) || 0, target: Number(g('target')) || 0 });
  }
  return out;
}
function readTeams(ws, headerRow, cols) {
  const out = [];
  for (let r = headerRow + 1; r <= Math.min(ws.rowCount || 0, 500); r++) {
    const vals = rowValues(ws, r), g = (k) => (cols[k] ? vals[cols[k]] || '' : '');
    const name = g('team').replace(/\s+/g, ' ').trim(); if (!name) continue;
    const members = splitNames(g('members')).concat((cols.member || []).map((c) => (vals[c] || '').trim()).filter(Boolean)).map(tidyName);
    const sec = g('section');
    out.push({ row: r, name, section: sec ? (/kid|child|junior|under|u\s?\d/i.test(sec) ? 'kids' : 'adults') : '', games: splitNames(g('games').replace(/\//g, ',')), members });
  }
  return out;
}
const pad = (n) => String(n).padStart(2, '0');
function dateOf(v) {
  if (v instanceof Date && !isNaN(v)) return v.getUTCFullYear() + '-' + pad(v.getUTCMonth() + 1) + '-' + pad(v.getUTCDate());
  return toDob(cellText(v));
}
function timeOf(v) {
  if (v instanceof Date && !isNaN(v)) return pad(v.getUTCHours()) + ':' + pad(v.getUTCMinutes());
  if (typeof v === 'number' && v > 0 && v < 1) { const m = Math.round(v * 1440); return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  const t = cellText(v), m = t.match(/(\d{1,2})[:.](\d{2})\s*([ap]\.?m\.?)?/i) || (t.match(/\b(\d{1,2})\s*([ap])\.?m\b\.?/i) ? (([x, hh, ap]) => [x, hh, '00', ap + 'm'])(t.match(/\b(\d{1,2})\s*([ap])\.?m\b\.?/i)) : null); if (!m) return '';
  let h = Number(m[1]); if (m[3] && /p/i.test(m[3]) && h < 12) h += 12; if (m[3] && /a/i.test(m[3]) && h === 12) h = 0;
  return h < 24 ? pad(h) + ':' + m[2] : '';
}
function stageOf(t) {
  const s = String(t || '').toLowerCase();
  if (/semi/.test(s)) return 'Semi-final'; if (/quarter/.test(s)) return 'Quarter-final'; if (/third|3rd|bronze/.test(s)) return 'Third place';
  if (/play.?off/.test(s)) return 'Play-off'; const ro = s.match(/round of (\d+)/); if (ro) return 'Round of ' + ro[1];
  if (/final/.test(s)) return 'Final'; return 'League';
}
function readFixtures(ws, headerRow, cols) {
  const out = [];
  for (let r = headerRow + 1; r <= Math.min(ws.rowCount || 0, 1000); r++) {
    const vals = rowValues(ws, r), g = (k) => (cols[k] ? vals[cols[k]] || '' : '');
    const a = g('a'), b = g('b'); if (!a && !b) continue;
    const when = cols.when ? rawCell(ws, r, cols.when) : null;
    const date = cols.date ? dateOf(rawCell(ws, r, cols.date)) : when ? dateOf(when) : '';
    const time = cols.time ? timeOf(rawCell(ws, r, cols.time)) : when ? timeOf(when) : '';
    const st = g('stage'), rn = (st.match(/round\s*(\d+)(?!\s*of)/i) || [])[1], grp = (g('group') || (st.match(/group\s*([a-z0-9]{1,2})\b/i) || [])[1] || '').toUpperCase();
    out.push({ row: r, game: g('game'), sideA: splitNames(a).map(tidyName), sideB: splitNames(b).map(tidyName), stage: stageOf(st), round: rn ? Number(rn) : 0, group: grp.slice(0, 4),
      startsAt: date && time ? date + 'T' + time : '', time: !date && time ? time : (date && !time ? date : ''), court: g('court'), referee: g('referee'), score: g('score') });
  }
  return out;
}

/* Rows of one sheet as plain player records. opts: { headerRow, map, eventCols, eventId, section } */
function readRows(ws, opts, events) {
  const out = [], map = opts.map || {};
  const get = (vals, k) => (map[k] ? vals[map[k]] || '' : '');
  for (let r = (opts.headerRow || 1) + 1; r <= Math.min(ws.rowCount || 0, 2000); r++) {
    const vals = rowValues(ws, r);
    const name = tidyName(get(vals, 'name') || [get(vals, 'firstName'), get(vals, 'lastName')].filter(Boolean).join(' '));
    if (!name || /^\d+$/.test(name)) continue;
    const secTxt = get(vals, 'section');
    const section = secTxt ? (/kid|child|junior|under|u\s?\d|\bboys?\b|\bgirls?\b|minor/i.test(secTxt) ? 'kids' : 'adults') : opts.section || 'adults';
    const age = (get(vals, 'age').match(/\d{1,3}/) || [])[0] || '';
    const groupTxt = get(vals, 'ageGroup') || (section === 'kids' && /under|u\s?\d/i.test(secTxt) ? secTxt.replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ') : '');
    const villa = get(vals, 'villa');
    const games = get(vals, 'games').split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
    (opts.eventCols || []).forEach((ec) => { if (truthy(vals[ec.col] || '')) games.push(ec.eventName); });
    const sports = [...new Set((opts.sportCols || []).filter((sc) => truthy(vals[sc.col] || '')).map((sc) => sc.sport))];
    let fromSheet = false;
    if (!games.length && !sports.length && opts.eventId) { const e = events.find((x) => x.id === opts.eventId); if (e) { games.push(e.name); fromSheet = true; } }
    out.push({
      row: r, name, section, gender: toGender(get(vals, 'gender')), phone: get(vals, 'phone'), email: get(vals, 'email'),
      dob: toDob(get(vals, 'dob')), ageGroup: age && Number(age) < 100 ? 'Age ' + Number(age) : groupTxt,
      affiliation: get(vals, 'affiliation') || (villa ? (/^\d+[a-z]?$/i.test(villa) ? 'Villa ' + villa : villa) : ''), games, sports, fromSheet, team: get(vals, 'team'),
    });
  }
  return out;
}

module.exports = { timeOf, dateOf, FIELDS, FIELD_KEYS, inspectSheet, readRows, readGames, readTeams, readFixtures, sheetKind, kindColumns, eventByName, eventForSport, sportOfHeader, tidyName, cellText, fieldFor, SPORT_KEYS: SPORT_WORDS.map((x) => x[0]) };
