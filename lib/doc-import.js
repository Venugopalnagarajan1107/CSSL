'use strict';
/* Fixtures from Word (.docx) and PowerPoint (.pptx) files.
   Both are zip files of XML. We read their tables (and, for lines outside tables, "Raja vs Manjesh" text)
   and turn them into plain rows: Player A, Player B, Date, Time, Court, Round, Score – the same layout as
   the Excel template, so the normal fixtures import (names, preview, duplicates) does the rest.
   Pictures and PDFs are not read: recognising text in them is not reliable enough to create matches. */
const JSZip = require('jszip');

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s).replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, n, d, x) => (n ? ENT[n] : String.fromCodePoint(d ? Number(d) : parseInt(x, 16))));
/* text of a piece of XML: its runs <w:t>/<a:t> in order; tabs and line breaks become spaces */
function textOf(xml, ns) {
  const re = new RegExp('<' + ns + ':t(?:\\s[^>]*)?>([\\s\\S]*?)</' + ns + ':t>|<' + ns + ':(?:tab|br)\\b[^>]*/>', 'g');
  let s = '', m; while ((m = re.exec(xml))) s += m[1] !== undefined ? m[1] : ' ';
  return unxml(s).replace(/\s+/g, ' ').trim();
}
const between = (xml, tag) => { const out = [], re = new RegExp('<' + tag + '\\b(?:[^>]*[^/>])?>([\\s\\S]*?)</' + tag + '>', 'g'); let m; while ((m = re.exec(xml))) out.push(m[1]); return out; };

/* tables -> rows of cell texts; paragraphs outside tables -> lines */
function fromXml(xml, ns) {
  const tblTag = ns + ':tbl', trTag = ns + ':tr', tcTag = ns + ':tc', pTag = ns + ':p';
  const tables = between(xml, tblTag).map((t) => between(t, trTag).map((tr) => between(tr, tcTag).map((tc) => between(tc, pTag).map((p) => textOf(p, ns)).filter(Boolean).join(' ').trim())));
  const rest = xml.replace(new RegExp('<' + tblTag + '\\b[\\s\\S]*?</' + tblTag + '>', 'g'), '');
  const lines = between(rest, pTag).map((p) => textOf(p, ns)).filter(Boolean);
  return { tables, lines };
}
async function readDocx(buf) {
  const zip = await JSZip.loadAsync(buf), f = zip.file('word/document.xml');
  if (!f) return null;
  return fromXml(await f.async('string'), 'w');
}
async function readPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!slides.length) return null;
  const out = { tables: [], lines: [] };
  for (const n of slides) { const r = fromXml(await zip.file(n).async('string'), 'a'); out.tables.push(...r.tables); out.lines.push(...r.lines); }
  return out;
}
/* What kind of office file is this zip? */
async function officeKind(buf) {
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) return '';
  try { const zip = await JSZip.loadAsync(buf); if (zip.file('word/document.xml')) return 'docx'; if (Object.keys(zip.files).some((n) => n.startsWith('ppt/slides/'))) return 'pptx'; if (zip.file('xl/workbook.xml')) return 'xlsx'; } catch (e) { /* not a zip */ }
  return '';
}

const VS = /\s+(?:vs\.?|v\.?|versus|x)\s+/i;
const DATE = /\b(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+\d{4})?)\b/i;
const TIME = /\b\d{1,2}[:.]\d{2}\s*(?:[ap]\.?m\.?)?|\b\d{1,2}\s*[ap]\.?m\.?/i;
const COURT = /\b(court|table|board|ct\.?|tbl\.?)\s*[#:]?\s*[a-z0-9]+/i;
const ROUND = /\b(league|round\s*\d+|group\s*[a-z0-9]{1,2}|quarter[- ]?final|semi[- ]?final|final|third place|play[- ]?off)\b/i;
const SCORE = /^\d{1,2}\s*[-–:]\s*\d{1,2}(\s*[,;/]\s*\d{1,2}\s*[-–:]\s*\d{1,2})*$/;
const HEAD = { a: /^((side|team|player|home)\s*(a|1)|home|side 1)$/i, b: /^((side|team|player|away)\s*(b|2)|away|opponent|side 2)$/i, date: /^(date|day|match date)$/i, time: /^(time|start|start time|slot|match time)$/i,
  court: /^(court|table|board|venue|location)$/i, round: /^(stage|round|phase|group|pool)$/i, score: /^(score|scores|result|set scores)$/i, match: /^(match|fixture|game|matches|fixtures)$/i };
const clean = (s) => String(s || '').replace(/^\s*(match\s*)?#?\d+[.):-]?\s+(?=\D)/i, '').replace(/\s+/g, ' ').trim();

/* One row of cells (or one line of text) -> a fixture, when it holds two sides. */
function rowToFixture(cells, cols) {
  const f = { a: '', b: '', date: '', time: '', court: '', round: '', score: '' };
  if (cols && cols.a != null && cols.b != null) {
    f.a = clean(cells[cols.a]); f.b = clean(cells[cols.b]);
    ['date', 'time', 'court', 'round', 'score'].forEach((k) => { if (cols[k] != null) f[k] = String(cells[cols[k]] || '').trim(); });
  } else {
    const all = cells.map((c) => String(c || '').trim()).filter(Boolean);
    const vsCell = all.find((c) => VS.test(c));
    if (!vsCell) return null;
    const [a, ...rest] = vsCell.split(VS); let b = rest.join(' ');
    /* a line may carry the rest too: "Raja vs Manjesh – 29/11 10:30 Table 2" */
    const tail = (b.match(/\s+[-–—|,(]\s*.*$/) || [''])[0]; if (tail && (DATE.test(tail) || TIME.test(tail) || COURT.test(tail))) b = b.slice(0, b.length - tail.length);
    /* "Ravi Kumar 12:00 PM Table 3" with no separator: lift the date / time / table / round off the end of the name */
    const lift = (txt) => { let t = txt; [['date', DATE], ['time', TIME], ['court', COURT], ['round', ROUND]].forEach(([k, re]) => { const m = t.match(re); if (m) { if (!f[k]) f[k] = m[0]; t = t.replace(m[0], ' '); } }); return t.replace(/[\s,;|()–—-]+$/g, '').replace(/\s+/g, ' ').trim(); };
    b = lift(b);
    f.a = clean(a); f.b = clean(b);
    const others = all.filter((c) => c !== vsCell).concat(tail ? [tail] : []);
    others.forEach((c) => {
      if (!f.score && SCORE.test(c)) f.score = c;
      if (!f.date && DATE.test(c)) f.date = c.match(DATE)[0];
      if (!f.time && TIME.test(c)) f.time = c.match(TIME)[0];
      if (!f.court && COURT.test(c)) f.court = c.match(COURT)[0];
      if (!f.round && ROUND.test(c)) f.round = c.match(ROUND)[0];
    });
    const both = vsCell + ' ' + (tail || '');
    if (!f.date && DATE.test(both)) f.date = both.match(DATE)[0];
    if (!f.time && TIME.test(both)) f.time = both.match(TIME)[0];
  }
  f.a = f.a.replace(/[,;:–—-]+$/, '').trim(); f.b = f.b.replace(/[,;:–—-]+$/, '').trim();
  ['date', 'time', 'court', 'round', 'score'].forEach((k) => { f[k] = String(f[k] || '').trim(); });
  return f.a && f.b && f.a.length < 80 && f.b.length < 80 ? f : null;
}
/* All fixtures found in a document: tables first (using a header row when there is one), then loose lines. */
function fixturesOf(doc) {
  const out = [];
  for (const t of doc.tables) {
    if (!t.length) continue;
    const head = t[0].map((c) => String(c || '').trim()), cols = {};
    head.forEach((c, i) => Object.entries(HEAD).forEach(([k, re]) => { if (cols[k] == null && re.test(c)) cols[k] = i; }));
    const hasHead = cols.a != null && cols.b != null;
    (hasHead || Object.keys(cols).length >= 2 ? t.slice(1) : t).forEach((r) => { const f = rowToFixture(r, hasHead ? cols : null); if (f) out.push(f); });
  }
  doc.lines.forEach((l) => { const f = rowToFixture([l], null); if (f) out.push(f); });
  return out;
}
/* Fixtures -> worksheet rows with the template's headers */
function asRows(fixtures) {
  return [['Player A', 'Player B', 'Date', 'Time', 'Court', 'Round', 'Score']].concat(fixtures.map((f) => [f.a, f.b, f.date, f.time, f.court, f.round, f.score]));
}
module.exports = { officeKind, readDocx, readPptx, fixturesOf, asRows, rowToFixture };
