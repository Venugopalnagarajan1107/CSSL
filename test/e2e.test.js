'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 10000 + Math.floor(Math.random() * 40000);
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-'));
const BASE = 'http://localhost:' + PORT;
let proc, adminPin, out = '';

const call = async (method, url, body, token) => {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'x-token': token || '' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) { /* none */ }
  return { status: r.status, body: j };
};

test.before(async () => {
  proc = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, DATA_DIR: DIR } });
  proc.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 50 && !/Admin PIN/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  adminPin = /Admin PIN\s*:\s*(\d+)/.exec(out)[1];
});
test.after(async () => { await new Promise((r) => { proc.once('exit', r); proc.kill(); }); fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 }); });

test('full tournament flow', async () => {
  // permissions
  assert.equal((await call('POST', '/api/admin/players', { name: 'X' })).status, 401);
  assert.equal((await call('POST', '/api/login', { role: 'admin', pin: '0000x' })).status, 401);
  const admin = (await call('POST', '/api/login', { role: 'admin', pin: adminPin })).body.token;

  // seeded events
  let st = (await call('GET', '/api/state')).body;
  assert.equal(st.events.length, 9, '5 adult + 4 kids events');
  assert.equal(st.events[0].config.rankBy, 'tally');
  const wd = st.events.find((e) => /Women/.test(e.name));
  assert.equal(st.events.filter((e) => e.section === 'kids').length, 4);

  // players + enrol
  const names = ['Asha', 'Bina', 'Chitra', 'Divya', 'Esha', 'Farah'];
  const ids = [];
  for (const n of names) ids.push((await call('POST', '/api/admin/players', { name: n, gender: 'F' }, admin)).body.id);
  await call('PUT', '/api/admin/events/' + wd.id, { participantIds: ids, config: { target: 15, winBy: 1, cap: 0 } }, admin);   // this test plays 15-point games

  // referee login
  const ref = (await call('POST', '/api/admin/referees', { name: 'Ref One', pin: '4321' }, admin)).body;
  const refTok = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: '4321' })).body.token;
  assert.equal((await call('POST', '/api/admin/players', { name: 'Hack' }, refTok)).status, 403, 'referee cannot use admin routes');

  // fixture validation
  assert.equal((await call('POST', '/api/admin/matches', { eventId: wd.id, sideA: [ids[0]], sideB: [ids[1]] }, admin)).status, 400, 'doubles needs 2 per side');
  assert.equal((await call('POST', '/api/admin/matches', { eventId: wd.id, sideA: [ids[0], ids[1]], sideB: [ids[1], ids[2]] }, admin)).status, 400, 'duplicate player');
  const m = (await call('POST', '/api/admin/matches', { eventId: wd.id, sideA: [ids[0], ids[1]], sideB: [ids[2], ids[3]], court: 'Court 1', refereeId: ref.id }, admin)).body;

  // referee scores a whole match (2 games), idempotent replay
  const ops = [];
  let n = 0; const cid = () => 'c' + n++;
  for (let g = 0; g < 2; g++) { for (let i = 0; i < 10; i++) ops.push({ type: 'point', s: 'B', inc: 1, cid: cid() }); for (let i = 0; i < 15; i++) ops.push({ type: 'point', s: 'A', inc: 1, cid: cid() }); }
  await call('POST', '/api/matches/' + m.id + '/ops', { ops }, refTok);
  await call('POST', '/api/matches/' + m.id + '/ops', { ops }, refTok); // replay: must not double count
  st = (await call('GET', '/api/state')).body;
  const sm = st.matches[0];
  assert.equal(sm.log.length, 50);
  const E = require('../public/engine.js');
  const evn = st.events.find((e) => e.id === wd.id);
  const d = E.derive(sm, evn);
  assert.equal(d.status, 'completed'); assert.equal(d.winner, 'A');
  const rows = E.standings(evn, st.matches);
  const asha = rows.find((r) => r.id === ids[0]);
  assert.equal(asha.pf, 15); // two games of 15, split by 2 => 15 each
  assert.equal(asha.pa, 10); // 10 + 10 conceded, split => 10
  assert.equal(rows[0].rank, 1);

  // no scoring after the match ended
  await call('POST', '/api/matches/' + m.id + '/ops', { ops: [{ type: 'point', s: 'B', inc: 1, cid: 'late' }] }, refTok);
  assert.equal((await call('GET', '/api/state')).body.matches[0].log.length, 50);

  // player profiles are permanent – never deleted (only pending registrations can be rejected)
  assert.equal((await call('DELETE', '/api/admin/players/' + ids[0], null, admin)).status, 403);
  // reset + delete match, then delete player
  const chiefRef = (await call('POST', '/api/admin/referees', { name: 'Chief', kind: 'chief', pin: '5599' }, admin)).body;
  const chiefTok = (await call('POST', '/api/login', { role: 'referee', refereeId: chiefRef.id, pin: '5599' })).body.token;
  assert.equal((await call('POST', '/api/admin/matches/' + m.id + '/reset', null, admin)).status, 403, 'organizers cannot reset scores');
  await call('POST', '/api/admin/matches/' + m.id + '/reset', null, chiefTok);
  assert.equal((await call('GET', '/api/state')).body.matches[0].log.length, 0);
  await call('DELETE', '/api/admin/matches/' + m.id, null, admin);
  assert.equal((await call('DELETE', '/api/admin/players/' + ids[0], null, admin)).status, 403, 'still permanent after the match is gone');

  // chess result mode
  const chess = st.events.find((e) => e.name === 'Chess');
  await call('PUT', '/api/admin/events/' + chess.id, { participantIds: [ids[1], ids[2]] }, admin);
  const cm = (await call('POST', '/api/admin/matches', { eventId: chess.id, sideA: [ids[1]], sideB: [ids[2]] }, admin)).body;
  await call('POST', '/api/matches/' + cm.id + '/ops', { ops: [{ type: 'result', result: 'D', cid: 'r1' }] }, refTok);
  st = (await call('GET', '/api/state')).body;
  assert.equal(E.derive(st.matches[0], st.events.find((e) => e.id === chess.id)).draw, true);

  // exports + backup
  assert.equal((await fetch(BASE + '/api/export.xlsx')).status, 403, 'reports are for organizers and referees only');
  const x = await fetch(BASE + '/api/export.xlsx', { headers: { 'x-token': admin } });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'xlsx is a zip');
  const bk = await fetch(BASE + '/api/admin/backup', { headers: { 'x-token': admin } });
  const bj = await bk.json(); assert.ok(bj.players.length >= 5); assert.ok(bj.uploads && typeof bj.uploads === 'object');

  // static + manifest
  assert.equal((await fetch(BASE + '/')).status, 200);
  assert.equal((await fetch(BASE + '/manifest.webmanifest')).status, 200);
  assert.equal((await fetch(BASE + '/..%2Fserver.js')).status === 200, false, 'no path traversal');
});

test('image upload requires staff and valid type', async () => {
  const admin = (await call('POST', '/api/login', { role: 'admin', pin: adminPin })).body.token;
  const bad = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'text/plain' }, body: 'hi' });
  assert.equal(bad.status, 400);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const ok = await fetch(BASE + '/api/upload', { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'image/png' }, body: png });
  const j = await ok.json();
  assert.match(j.url, /^\/uploads\/.+\.png$/);
  assert.equal((await fetch(BASE + j.url)).status, 200);
});
