'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('referees take an unassigned match in their sport (not their own), or withdraw before it starts', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const st = (await call('GET', '/api/state', null, admin)).body;
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const P = {}; for (const n of ['Asha', 'Bala', 'Chitra', 'Ref Ravi', 'Ref Uma', 'Chess Cee']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;
    await call('POST', '/api/admin/tournaments/' + tt.tid + '/roster', { add: Object.values(P) }, admin);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: [P.Asha, P.Bala, P.Chitra, P['Ref Ravi']] }, admin);
    const role = async (n, sports) => (await call('POST', '/api/login', { pin: (await call('POST', '/api/admin/people/' + P[n] + '/roles', { referee: 'referee', sports }, admin)).body.pin })).body.token;
    const ravi = await role('Ref Ravi', ['tt']), uma = await role('Ref Uma', ['tt']), cee = await role('Chess Cee', ['chess']);
    const mk = async (a, b) => (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [P[a]], sideB: [P[b]] }, admin)).body.id;
    const m1 = await mk('Asha', 'Bala'), m2 = await mk('Ref Ravi', 'Chitra');
    const take = (id, tok) => call('POST', '/api/staff/matches/' + id + '/take', {}, tok);

    assert.equal((await take(m1)).status, 401);
    assert.equal((await take(m1, cee)).status, 403, 'not mapped to table tennis');
    assert.equal((await take(m2, ravi)).status, 403, 'plays in it');
    assert.equal((await take(m1, ravi)).status, 200);
    assert.equal((await take(m1, uma)).status, 409, 'already taken');
    let m = (await call('GET', '/api/state', null, admin)).body.matches.find((x) => x.id === m1);
    const raviRef = (await call('GET', '/api/state', null, admin)).body.referees.find((r) => r.playerId === P['Ref Ravi']).id;
    assert.deepEqual(m.refereeIds, [raviRef]);
    // withdraw, then Uma takes it; once it has started, withdrawing goes through the organizer
    assert.equal((await call('POST', '/api/staff/matches/' + m1 + '/release', {}, ravi)).status, 200);
    assert.equal((await take(m1, uma)).status, 200);
    assert.equal((await call('POST', '/api/matches/' + m1 + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'x' }] }, uma)).status, 200);
    assert.equal((await call('POST', '/api/staff/matches/' + m1 + '/release', {}, uma)).status, 409);
    // cancelled or completed matches cannot be taken
    const m3 = await mk('Asha', 'Chitra'); await call('POST', '/api/admin/matches/' + m3 + '/cancel', {}, admin);
    assert.equal((await take(m3, ravi)).status, 409);
  } finally { await s.stop(); }
});
