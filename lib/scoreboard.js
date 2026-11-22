'use strict';
/* Reading a published scoreboard page (like the CS table tennis one) for its results.
   The page keeps its data in a  const INITIAL_DATA = { seniors: { players, matches: [{ id, a, b, ga, gb, detail }] }, … }  block.
   That block is read as data (JSON) – the page's own code is never run. */
const dns = require('dns').promises;
const net = require('net');

/* Only public https pages: no local or private network addresses (so the server cannot be pointed at itself). */
function privateIp(ip) {
  if (net.isIPv6(ip)) { const x = ip.toLowerCase(); return x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.'); }
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
}
async function checkUrl(u) {
  let url; try { url = new URL(String(u || '').trim()); } catch (e) { throw new Error('That is not a web address.'); }
  const testing = process.env.SCOREBOARD_ALLOW_LOCAL === '1';   /* only the automated tests set this, to serve a page from this machine */
  if (url.protocol !== 'https:' && !(testing && url.protocol === 'http:')) throw new Error('Use an https:// link.');
  if (url.username || url.password || (url.port && !testing)) throw new Error('Use a plain https:// link.');
  const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error('That site cannot be found.');
  if (!testing && addrs.some((a) => privateIp(a.address))) throw new Error('That address is not a public website.');
  return url.toString();
}
async function fetchPage(u) {
  const url = await checkUrl(u);
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'tournament-app scoreboard sync', Accept: 'text/html' } });
  if (!r.ok) throw new Error('The scoreboard page answered ' + r.status + '.');
  const text = await r.text();
  if (text.length > 3e6) throw new Error('The scoreboard page is too large.');
  return text;
}
/* the object literal after "INITIAL_DATA =" – brackets counted outside strings */
function extract(html) {
  const k = html.search(/\bINITIAL_DATA\s*=\s*\{/); if (k < 0) throw new Error('No scoreboard data found on that page.');
  const i = html.indexOf('{', k); let depth = 0, q = '', j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (q) { if (c === '\\') j++; else if (c === q) q = ''; continue; }
    if (c === '"' || c === "'" || c === '`') q = c; else if (c === '{') depth++; else if (c === '}' && !--depth) { j++; break; }
  }
  let data; try { data = JSON.parse(html.slice(i, j)); } catch (e) { throw new Error('The scoreboard data could not be read.'); }
  const out = {};
  Object.entries(data || {}).forEach(([cat, v]) => {
    if (!v || !Array.isArray(v.matches)) return;
    out[cat] = { players: (v.players || []).map(String).slice(0, 200), matches: v.matches.slice(0, 2000).map((m) => ({ id: String(m.id || ''), a: String(m.a || ''), b: String(m.b || ''), ga: m.ga == null ? null : Number(m.ga), gb: m.gb == null ? null : Number(m.gb), detail: String(m.detail || '') })) };
  });
  if (!Object.keys(out).length) throw new Error('No categories with matches on that page.');
  return out;
}
/* set scores ("11-4, 11-3") may be written from either side: turn them to the side that the game count (ga-gb) says */
function orient(m) {
  const g = String(m.detail || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => x.split(/\s*[-–:]\s*/).map(Number));
  if (!g.length || g.some((x) => x.length !== 2 || x.some((n) => !Number.isFinite(n)))) return null;
  const won = (gs) => [gs.filter(([a, b]) => a > b).length, gs.filter(([a, b]) => b > a).length];
  const flip = g.map(([a, b]) => [b, a]);
  if (won(g)[0] === m.ga && won(g)[1] === m.gb) return { games: g, flipped: false };
  if (won(flip)[0] === m.ga && won(flip)[1] === m.gb) return { games: flip, flipped: true };
  return null;
}
module.exports = { fetchPage, extract, orient, checkUrl };
