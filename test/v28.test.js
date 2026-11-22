'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { start } = require('./helpers');

const page = (data) => '<!doctype html><script>\nconst ORGANIZER_PIN = "1";\nconst INITIAL_DATA = ' + JSON.stringify(data, null, 1) + ';\nlet state = INITIAL_DATA;\n</script>';

test('scoreboard reader: only public https pages; data read without running the page', async () => {
  delete process.env.SCOREBOARD_ALLOW_LOCAL;
  const S = require('../lib/scoreboard.js');
  await assert.rejects(S.checkUrl('http://example.com/'), /https/);
  await assert.rejects(S.checkUrl('https://127.0.0.1/'), /public/);
  await assert.rejects(S.checkUrl('https://localhost/'), /public|found/);
  await assert.rejects(S.checkUrl('https://10.0.0.5/'), /public/);
  const d = S.extract(page({ seniors: { players: ['A {x}'], matches: [{ id: 'S1', a: 'A {x}', b: 'B', ga: 2, gb: 0, detail: '11-4, 11-3' }] } }) + '<script>alert(1)</script>');
  assert.equal(d.seniors.matches[0].a, 'A {x}');
  assert.deepEqual(S.orient({ ga: 0, gb: 2, detail: '11-4, 11-3' }).games, [[4, 11], [3, 11]], 'written from the winner side');
  assert.equal(S.orient({ ga: 2, gb: 0, detail: '11-4, 3-11' }), null);
});

test('sync scores from a scoreboard page: preview, aliases, enter, never overwrite, auto settings', async () => {
  let data = { seniors: { players: ['Raja', 'Manjesh', 'Srini', 'Raghu'], matches: [
    { id: 'S1', a: 'Raja', b: 'Manjesh', ga: 2, gb: 1, detail: '11-2, 10-12, 11-3' },
    { id: 'S2', a: 'Raja', b: 'Srini', ga: 0, gb: 2, detail: '11-4, 11-3' },          // winner's side first
    { id: 'S3', a: 'Manjesh', b: 'Raghu', ga: null, gb: null, detail: '' },
    { id: 'S4', a: 'Srini', b: 'Raghu', ga: 2, gb: 0, detail: '11-9, 11-9' } ] }, juniors: { players: [], matches: [] } };
  const board = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page(data)); });
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  const link = 'http://127.0.0.1:' + board.address().port + '/';
  const s = await start({ env: { SCOREBOARD_ALLOW_LOCAL: '1' } });
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const E = require('../public/engine.js');
    let st = (await call('GET', '/api/state', null, admin)).body;
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const P = {}; for (const n of ['Raja', 'Manjesh', 'Srinivasan Thoyyeti', 'Raghunath Babu']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;
    await call('POST', '/api/admin/tournaments/' + tt.tid + '/roster', { add: Object.values(P) }, admin);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: Object.values(P) }, admin);
    const m1 = (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [P.Manjesh], sideB: [P.Raja] }, admin)).body;   // stored the other way round

    // defaults: the CS link and the category by section
    const def = (await call('GET', '/api/admin/events/' + tt.id + '/sync-settings', null, admin)).body;
    assert.match(def.url, /cs-tt-tournament-2026/); assert.equal(def.category, 'seniors');
    assert.equal((await call('PUT', '/api/admin/events/' + tt.id + '/sync-settings', { url: 'http://' }, admin)).status, 400);
    await call('PUT', '/api/admin/events/' + tt.id + '/sync-settings', { url: link }, admin);

    // preview: Srini is a unique short name; "Raghu" is not a prefix of Raghunath? it is -> matched; nothing saved
    let p = (await call('POST', '/api/admin/events/' + tt.id + '/sync', { dry: true }, admin)).body;
    assert.deepEqual(p.categories, ['seniors', 'juniors']);
    assert.equal(p.enter.length, 3); assert.equal(p.create.length, 3, 'S2, S3, S4 are new fixtures'); assert.equal(p.pending, 1); assert.deepEqual(p.unknown, []);
    assert.equal((await call('GET', '/api/state', null, admin)).body.matches.length, 1, 'preview saves nothing');

    // a name the app cannot place: mapped once, remembered
    data.seniors.matches.push({ id: 'S5', a: 'RB', b: 'Raja', ga: 0, gb: 2, detail: '5-11, 6-11' });
    p = (await call('POST', '/api/admin/events/' + tt.id + '/sync', { dry: true }, admin)).body;
    assert.equal(p.unknown[0].name, 'RB');
    await call('PUT', '/api/admin/events/' + tt.id + '/sync-settings', { aliases: { RB: P['Raghunath Babu'] } }, admin);

    // sync: results entered with set scores in the right orientation
    p = (await call('POST', '/api/admin/events/' + tt.id + '/sync', {}, admin)).body;
    assert.equal(p.enter.length, 4); assert.equal(p.create.length, 4);
    st = (await call('GET', '/api/state', null, admin)).body;
    const ev = st.events.find((e) => e.id === tt.id);
    const one = st.matches.find((m) => m.id === m1.id), d1 = E.derive(one, ev);
    assert.equal(d1.status, 'completed'); assert.equal(d1.winner, 'B', 'Raja (side B in the app) won'); assert.deepEqual(d1.games.map((g) => g.a + '-' + g.b), ['2-11', '12-10', '3-11']);
    const s2 = st.matches.find((m) => m.sideA[0] === P.Raja && m.sideB[0] === P['Srinivasan Thoyyeti']);
    assert.equal(E.derive(s2, ev).winner, 'B');
    assert.equal(ev.sync.last.entered, 4);

    // again: nothing new; a different result on the page is listed, the app keeps its own
    p = (await call('POST', '/api/admin/events/' + tt.id + '/sync', {}, admin)).body;
    assert.equal(p.enter.length, 0); assert.equal(p.same, 4);
    data.seniors.matches[0] = { ...data.seniors.matches[0], ga: 0, gb: 2, detail: '1-11, 1-11' };
    p = (await call('POST', '/api/admin/events/' + tt.id + '/sync', {}, admin)).body;
    assert.equal(p.conflicts.length, 1); assert.match(p.conflicts[0], /page 0-2, app 2-1/);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.equal(E.derive(st.matches.find((m) => m.id === m1.id), ev).winner, 'B', 'not overwritten');

    // auto-sync is a setting; a wrong category is explained
    assert.equal((await call('PUT', '/api/admin/events/' + tt.id + '/sync-settings', { auto: true }, admin)).body.auto, true);
    assert.match((await call('POST', '/api/admin/events/' + tt.id + '/sync', { dry: true, category: 'veterans' }, admin)).body.error, /no "veterans" category/);
    // not for players or sport leads of other sports
    const lead = (await call('POST', '/api/admin/admins', { name: 'Chess Lead', sports: ['chess'] }, admin)).body;
    const lt = (await call('POST', '/api/login', { role: 'admin', pin: lead.pin })).body.token;
    assert.equal((await call('POST', '/api/admin/events/' + tt.id + '/sync', { dry: true }, lt)).status, 403);
    assert.equal((await call('POST', '/api/admin/events/' + tt.id + '/sync', { dry: true })).status, 401);
  } finally { await s.stop(); board.close(); }
});
