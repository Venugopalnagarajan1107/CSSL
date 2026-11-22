'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start, chiefTok } = require('./helpers');
const E = require('../public/engine.js');

test('table tennis: a match win is one game worth 2 points, whatever the number of sets', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const ref = await chiefTok(s, admin);
    let st = (await call('GET', '/api/state', null, admin)).body;
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const bad = st.events.find((e) => e.sport === 'badminton' && e.sideSize === 1 && e.section === 'adults') || null;
    const P = {}; for (const n of ['Ana', 'Ben', 'Cy']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: Object.values(P) }, admin);
    const play = async (A, B, games) => {
      const m = (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [A], sideB: [B] }, admin)).body;
      const r = await call('POST', '/api/matches/' + m.id + '/paper', { games }, ref); assert.equal(r.status, 200, JSON.stringify(r.body));
    };
    await play(P.Ana, P.Ben, [{ a: 11, b: 5 }, { a: 9, b: 11 }, { a: 11, b: 7 }]);   // Ana wins in 3 sets
    await play(P.Ana, P.Cy, [{ a: 11, b: 3 }, { a: 11, b: 4 }]);                      // Ana wins in 2 sets
    st = (await call('GET', '/api/state', null, admin)).body;
    const ev = st.events.find((e) => e.id === tt.id);
    const rows = E.standings(ev, st.matches);
    const ana = rows.find((r) => r.id === P.Ana), ben = rows.find((r) => r.id === P.Ben);
    assert.deepEqual([ana.played, ana.won, ana.mp], [2, 2, 4], 'two matches won = 4 points, sets do not add points');
    assert.deepEqual([ben.played, ben.lost, ben.mp], [1, 1, 0]);
    // Rankings: table tennis win = 2 (other sports keep their own points)
    const rec = E.seasonRecords(st, st.matches);
    const rk = E.rankings([rec], { sport: 'tt' });
    assert.equal(rk.find((r) => r.id === P.Ana).points, 4);
    assert.equal(E.rankings([{ x: { badminton: { played: 1, won: 1 } } }], {}).find((r) => r.id === 'x').points, 3, 'badminton win still 3');
    assert.equal(E.rankings([{ x: { tt: { played: 1, won: 1 }, badminton: { played: 1, won: 1 } } }], {}).find((r) => r.id === 'x').points, 5, 'overall adds each sport by its own rule');
    assert.equal(E.rankings([{ x: { tt: { played: 1, won: 1 } } }], { ptsBySport: { tt: { win: 5 } } }).find((r) => r.id === 'x').points, 5, 'organizer can change it');
    // the organizer can change the table tennis points; it is saved
    await call('POST', '/api/admin/tournament', { rankPtsSport: { tt: { win: 2, loss: 0 } } }, admin);
    st = (await call('GET', '/api/state', null, admin)).body;
    assert.deepEqual(st.tournament.rankPtsSport.tt, { win: 2, draw: 1, loss: 0 });
    void bad;
  } finally { await s.stop(); }
});
