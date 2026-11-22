'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start, chiefTok } = require('./helpers');

test('match numbers follow the order of play; unplayed matches move, played ones stay', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const ref = await chiefTok(s, admin);
    const st0 = (await call('GET', '/api/state', null, admin)).body;
    const tt = st0.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const ids = []; for (let i = 1; i <= 6; i++) ids.push((await call('POST', '/api/admin/players', { name: 'P' + i }, admin)).body.id);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: ids }, admin);
    const M = [];   // M[k] = the match planned as #k
    for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
      const r = await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [ids[a]], sideB: [ids[b]] }, admin);
      assert.equal(r.status, 200, JSON.stringify(r.body)); M.push(r.body.id);
    }
    const planned = M.filter(Boolean); assert.equal(planned.length, 15);
    const P = (k) => planned[k - 1];
    const nos = async () => { const ms = (await call('GET', '/api/state', null, admin)).body.matches; return (k) => ms.find((x) => x.id === P(k)); };
    let g = await nos();
    assert.deepEqual(planned.map((_, i) => g(i + 1).no), [...Array(15)].map((_, i) => i + 1));

    const play = async (k) => { const r = await call('POST', '/api/matches/' + P(k) + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'c' + k }] }, ref); assert.equal(r.status, 200, JSON.stringify(r.body)); await s.settle(30); };
    for (const k of [1, 2, 3, 4]) await play(k);
    for (const k of [8, 9, 10, 11, 12]) await play(k);
    g = await nos();
    const want = { 1: 1, 2: 2, 3: 3, 4: 4, 8: 5, 9: 6, 10: 7, 11: 8, 12: 9, 5: 10, 6: 11, 7: 12, 13: 13, 14: 14, 15: 15 };
    for (const [k, n] of Object.entries(want)) assert.equal(g(+k).no, n, 'planned #' + k);
    assert.equal(g(8).plannedNo, 8);

    // editing a fixture keeps its number
    await call('PUT', '/api/admin/matches/' + P(13), { court: 'Court 3' }, admin);
    g = await nos(); assert.equal(g(13).no, 13); assert.equal(g(13).court, 'Court 3');

    // notify remembers the number it went out with
    await call('POST', '/api/staff/matches/' + P(7) + '/notify', { mark: 1 }, admin);
    // delete an unplayed match in the middle (planned #6, now #11): the ones after it move up
    assert.equal((await call('DELETE', '/api/admin/matches/' + P(6), null, admin)).status, 200);
    g = await nos();
    assert.equal(g(6), undefined);
    assert.deepEqual([7, 13, 14, 15].map((k) => g(k).no), [11, 12, 13, 14]);
    assert.deepEqual([1, 4, 8, 12].map((k) => g(k).no), [1, 4, 5, 9], 'played matches keep their numbers');
    assert.equal(g(7).notified.no, 12); assert.notEqual(g(7).no, g(7).notified.no);

    // restore it from Trash: back in its planned place
    const tr = (await call('GET', '/api/admin/trash', null, admin)).body.find((x) => x.col === 'matches');
    assert.equal((await call('POST', '/api/admin/trash/' + tr.id + '/restore', null, admin)).status, 200);
    g = await nos();
    assert.deepEqual([5, 6, 7, 13, 15].map((k) => g(k).no), [10, 11, 12, 13, 15]);

    // a new match goes to the end
    const extra = (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [ids[0]], sideB: [ids[1]] }, admin)).body;
    assert.equal(extra.no || (await call('GET', '/api/state', null, admin)).body.matches.find((x) => x.id === extra.id).no, 16);

    // a played match whose scores are reset goes back to the queue (planned order); the rest close up
    assert.equal((await call('POST', '/api/admin/matches/' + P(9) + '/reset', null, ref)).status, 200);
    g = await nos();
    assert.deepEqual([1, 4, 8, 10, 12].map((k) => g(k).no), [1, 4, 5, 6, 8]);
    assert.deepEqual([5, 6, 7, 9, 13].map((k) => g(k).no), [9, 10, 11, 12, 13]);

    // starting a queued match gives it the next number after the played ones
    await play(15);
    g = await nos();
    assert.equal(g(15).no, 9); assert.equal(g(5).no, 10);
  } finally { await s.stop(); }
});
