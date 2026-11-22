'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('games only offer referees mapped to their sport', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const R = async (name, sports, kind) => (await call('POST', '/api/admin/referees', { name, sports, kind: kind || 'referee' }, admin)).body.id;
    const rB = await R('Shuttle Ref', ['badminton']), rT = await R('Table Ref', ['tt']), rC = await R('Chief', [], 'chief'), rN = await R('Nobody', []);

    // a new event: each game gets only the event referees mapped to its sport (chief everywhere)
    const made = (await call('POST', '/api/staff/tournaments', { name: 'Spring Cup', refereeIds: [rB, rT, rC, rN], games: [{ sport: 'badminton' }, { sport: 'tt' }, { sport: 'chess' }] }, admin)).body;
    const st = (await call('GET', '/api/state', null, admin)).body, g = (sp) => st.events.find((e) => e.tid === made.tournament.id && e.sport === sp);
    assert.deepEqual(g('badminton').refereeIds.sort(), [rB, rC].sort());
    assert.deepEqual(g('tt').refereeIds.sort(), [rT, rC].sort());
    assert.deepEqual(g('chess').refereeIds, [rC]);

    // choosing a referee from another sport is refused; new referees typed for a game are mapped to its sport
    assert.match((await call('PUT', '/api/admin/events/' + g('tt').id + '/staff', { refereeIds: [rB] }, admin)).body.error, /not mapped to Table tennis/);
    const add = await call('PUT', '/api/admin/events/' + g('chess').id + '/staff', { refereeIds: [rC], newReferees: ['Arbiter A'] }, admin);
    assert.equal(add.status, 200);
    const arb = (await call('GET', '/api/state', null, admin)).body.referees.find((r) => r.name === 'Arbiter A');
    assert.deepEqual(arb.sports, ['chess']);

    // new game with no referees chosen: the event's referees for that sport
    const ng = (await call('POST', '/api/admin/games', { tid: made.tournament.id, sport: 'tt', kind: 'doubles' }, admin)).body.event;
    assert.deepEqual(ng.refereeIds.sort(), [rT, rC].sort());

    // match referees too
    const ids = []; for (const n of ['A1', 'B1']) ids.push((await call('POST', '/api/admin/players', { name: n }, admin)).body.id);
    await call('POST', '/api/admin/tournaments/' + made.tournament.id + '/roster', { add: ids }, admin);
    await call('PUT', '/api/admin/events/' + g('tt').id, { participantIds: ids }, admin);
    assert.match((await call('POST', '/api/admin/matches', { eventId: g('tt').id, sideA: [ids[0]], sideB: [ids[1]], refereeIds: [rB] }, admin)).body.error, /not mapped/);
    assert.equal((await call('POST', '/api/admin/matches', { eventId: g('tt').id, sideA: [ids[0]], sideB: [ids[1]], refereeIds: [rT] }, admin)).status, 200);

    // people & roles: the main admin sets the sports a referee covers
    const pid = (await call('POST', '/api/admin/players', { name: 'Coach Vee' }, admin)).body.id;
    await call('POST', '/api/admin/people/' + pid + '/roles', { referee: 'referee', sports: ['carrom', 'nonsense'] }, admin);
    const people = (await call('GET', '/api/admin/people', null, admin)).body.people;
    assert.deepEqual(people.find((x) => x.id === pid).refSports, ['carrom']);
  } finally { await s.stop(); }
});
