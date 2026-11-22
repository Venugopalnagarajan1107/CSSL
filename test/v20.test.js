'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start, chiefTok } = require('./helpers');

test('delete one, several or all matches; delete all fixtures of a game; both restore from Trash', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const ref = await chiefTok(s, admin);
    const st0 = (await call('GET', '/api/state', null, admin)).body;
    const tt = st0.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const ids = []; for (let i = 1; i <= 5; i++) ids.push((await call('POST', '/api/admin/players', { name: 'Q' + i }, admin)).body.id);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: ids }, admin);
    const M = []; for (let i = 1; i < 5; i++) for (const j of [0]) M.push((await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [ids[j]], sideB: [ids[i]] }, admin)).body.id);
    M.push((await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [ids[1]], sideB: [ids[2]] }, admin)).body.id);
    await call('POST', '/api/matches/' + M[0] + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'k' }] }, ref);
    const nos = async () => (await call('GET', '/api/state', null, admin)).body.matches.filter((m) => m.eventId === tt.id).sort((a, b) => a.no - b.no).map((m) => [M.indexOf(m.id), m.no]);

    // several at once (#2 and #4): the rest close up
    assert.equal((await call('POST', '/api/admin/matches/bulk-delete', { ids: [] }, admin)).status, 400);
    const r = (await call('POST', '/api/admin/matches/bulk-delete', { ids: [M[1], M[3]] }, admin)).body;
    assert.equal(r.removed, 2);
    assert.deepEqual(await nos(), [[0, 1], [2, 2], [4, 3]]);
    // one Trash item brings both back in their places
    let tr = (await call('GET', '/api/admin/trash', null, admin)).body.find((x) => x.col === 'fixtures');
    assert.match(tr.name, /^2 matches/);
    assert.equal((await call('POST', '/api/admin/trash/' + tr.id + '/restore', null, admin)).status, 200);
    assert.deepEqual(await nos(), [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5]]);
    assert.equal((await call('POST', '/api/admin/trash/' + tr.id + '/restore', null, admin)).status, 404, 'used up');

    // delete all fixtures of the game (one has scores → asks first), then restore
    assert.equal((await call('POST', '/api/admin/events/' + tt.id + '/reset-draw', {}, admin)).status, 409);
    assert.equal((await call('POST', '/api/admin/events/' + tt.id + '/reset-draw', { force: true }, admin)).body.removed, 5);
    assert.deepEqual(await nos(), []);
    tr = (await call('GET', '/api/admin/trash', null, admin)).body.find((x) => x.col === 'fixtures');
    assert.match(tr.name, /all 5 fixtures/);
    await call('POST', '/api/admin/trash/' + tr.id + '/restore', null, admin);
    assert.equal((await nos()).length, 5);

    // a sport lead for badminton cannot bulk-delete table tennis matches; a plain referee cannot at all
    const lead = (await call('POST', '/api/admin/admins', { name: 'Shuttle Lead', sports: ['badminton'] }, admin)).body;
    const lt = (await call('POST', '/api/login', { role: 'admin', pin: lead.pin })).body.token;
    assert.ok(lt, 'sport lead signed in'); assert.equal((await call('POST', '/api/admin/matches/bulk-delete', { ids: [M[2]] }, lt)).status, 403);
    assert.equal((await call('POST', '/api/admin/matches/bulk-delete', { ids: [M[2]] }, ref)).status, 403);
    assert.equal((await nos()).length, 5);
  } finally { await s.stop(); }
});
