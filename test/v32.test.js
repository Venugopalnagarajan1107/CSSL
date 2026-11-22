'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { start } = require('./helpers');

const page = (data) => '<!doctype html><script>\nconst INITIAL_DATA = ' + JSON.stringify(data) + ';\n</script>';

test('one sync brings both tabs in: seniors -> Table Tennis, juniors -> Kids – Table Tennis', async () => {
  const data = {
    seniors: { players: ['Raja', 'Manjesh'], matches: [{ id: 'S1', a: 'Raja', b: 'Manjesh', ga: 2, gb: 0, detail: '11-5, 11-6' }] },
    juniors: { players: ['Anu', 'Biju', 'Chinnu'], matches: [
      { id: 'J1', a: 'Anu', b: 'Biju', ga: 1, gb: 2, detail: '11-9, 5-11, 8-11' },
      { id: 'J2', a: 'Biju', b: 'Chinnu', ga: null, gb: null, detail: '' }] } };
  const board = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page(data)); });
  await new Promise((r) => board.listen(0, '127.0.0.1', r));
  const link = 'http://127.0.0.1:' + board.address().port + '/';
  const s = await start({ env: { SCOREBOARD_ALLOW_LOCAL: '1' } });
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const E = require('../public/engine.js');
    let st = (await call('GET', '/api/state', null, admin)).body;
    const tt = st.events.find((e) => e.sport === 'tt' && e.section === 'adults'), kt = st.events.find((e) => e.sport === 'tt' && e.section === 'kids');
    const P = {};
    for (const n of ['Raja', 'Manjesh']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;
    for (const n of ['Anu', 'Biju', 'Chinnu']) P[n] = (await call('POST', '/api/admin/players', { name: n, section: 'kids' }, admin)).body.id;
    await call('POST', '/api/admin/tournaments/' + tt.tid + '/roster', { add: Object.values(P) }, admin);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: [P.Raja, P.Manjesh] }, admin);
    await call('PUT', '/api/admin/events/' + kt.id, { participantIds: [P.Anu, P.Biju, P.Chinnu] }, admin);
    // the adults game was once set to "Juniors" by hand: it still takes the seniors tab
    await call('PUT', '/api/admin/events/' + tt.id + '/sync-settings', { url: link, category: 'Juniors' }, admin);
    assert.equal((await call('GET', '/api/admin/events/' + kt.id + '/sync-settings', null, admin)).body.url, link, 'the link is shared with the kids game');

    let p = (await call('POST', '/api/admin/events/' + tt.id + '/sync', { dry: true }, admin)).body;
    assert.deepEqual(p.games.map((g) => [g.eventId, g.category]), [[tt.id, 'seniors'], [kt.id, 'juniors']]);
    assert.equal(p.totals.enter, 2); assert.equal(p.totals.create, 3);
    assert.equal((await call('GET', '/api/state', null, admin)).body.matches.length, 0, 'preview saves nothing');

    p = (await call('POST', '/api/admin/events/' + tt.id + '/sync', {}, admin)).body;
    assert.equal(p.totals.enter, 2);
    st = (await call('GET', '/api/state', null, admin)).body;
    const kev = st.events.find((e) => e.id === kt.id);
    const j1 = st.matches.find((m) => m.eventId === kt.id && [m.sideA[0], m.sideB[0]].includes(P.Anu));
    const d = E.derive(j1, kev);
    assert.equal(d.status, 'completed'); assert.equal(j1[d.winner === 'A' ? 'sideA' : 'sideB'][0], P.Biju, 'Biju won the junior match');
    assert.equal(st.matches.filter((m) => m.eventId === kt.id).length, 2, 'the junior fixture still to play is created too');
    assert.equal(kev.sync.last.entered, 1); assert.equal(st.events.find((e) => e.id === tt.id).sync.last.entered, 1);

    // syncing from the kids game does the same both ways; nothing new now
    p = (await call('POST', '/api/admin/events/' + kt.id + '/sync', {}, admin)).body;
    assert.equal(p.games[0].eventId, kt.id); assert.equal(p.totals.enter, 0); assert.equal(p.totals.same, 2);
  } finally { await s.stop(); board.close(); }
});
