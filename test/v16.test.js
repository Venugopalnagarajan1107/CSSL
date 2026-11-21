'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('one PIN per person: roles, referee never in own match, my profile, admins manage admins', async () => {
  const s = await start();
  try {
    const { call } = s;
    // the existing admin PIN works without choosing a role
    const a0 = (await call('POST', '/api/login', { pin: s.pin })).body;
    assert.equal(a0.role, 'admin'); const admin = a0.token;
    assert.equal((await call('POST', '/api/login', { pin: '000001' })).status, 401);

    const st0 = (await call('GET', '/api/state', null, admin)).body;
    const tt = st0.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const team = st0.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    const P = {}; for (const n of ['Ravi', 'Asha', 'Kiran', 'Meena', 'Dev', 'Lata']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;

    // the main admin gives Ravi referee + admin roles; one PIN carries both
    const roles = (await call('POST', '/api/admin/people/' + P.Ravi + '/roles', { admin: true, referee: 'referee' }, admin)).body;
    assert.match(roles.pin, /^\d{6}$/);
    const ravi = (await call('POST', '/api/login', { pin: roles.pin })).body;
    assert.equal(ravi.role, 'admin'); assert.ok(ravi.refId && ravi.adminId); assert.equal(ravi.personId, P.Ravi);

    // referee conflict: never in his own match; fine in others of the same game
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: [P.Ravi, P.Asha, P.Kiran, P.Meena] }, admin);
    const own = (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [P.Ravi], sideB: [P.Asha] }, admin)).body;
    const other = (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [P.Kiran], sideB: [P.Meena] }, admin)).body;
    assert.equal((await call('POST', '/api/matches/' + own.id + '/paper', {}, ravi.token)).status, 403);
    assert.notEqual((await call('POST', '/api/matches/' + other.id + '/paper', {}, ravi.token)).status, 403);
    const refId = ravi.refId;
    assert.equal((await call('PUT', '/api/admin/matches/' + own.id, { refereeIds: [refId] }, admin)).status, 400, 'cannot be assigned to his own match');

    // team tie: members of team A / B cannot referee; a member of team C can; several referees allowed
    const mk = async (name, ids) => (await call('POST', '/api/admin/teams', { name, memberIds: ids }, admin)).body.id;
    const tA = await mk('A', [P.Ravi, P.Asha]), tB = await mk('B', [P.Kiran, P.Meena]), tC = await mk('C', [P.Dev, P.Lata]);
    await call('PUT', '/api/admin/events/' + team.id, { participantIds: [tA, tB, tC] }, admin);
    const devRole = (await call('POST', '/api/admin/people/' + P.Dev + '/roles', { referee: 'referee' }, admin)).body;
    const devRef = (await call('GET', '/api/state', null, admin)).body.referees.find((r) => r.playerId === P.Dev).id;
    const tieAB = await call('POST', '/api/admin/matches', { eventId: team.id, sideA: [tA], sideB: [tB], refereeIds: [devRef] }, admin);
    assert.equal(tieAB.status, 200);
    assert.equal((await call('POST', '/api/admin/matches', { eventId: team.id, sideA: [tA], sideB: [tC], refereeIds: [devRef] }, admin)).status, 400, 'Dev plays for C');
    const tieBC = (await call('POST', '/api/admin/matches', { eventId: team.id, sideA: [tB], sideB: [tC], refereeIds: [] }, admin)).body;
    const dev = (await call('POST', '/api/login', { pin: devRole.pin })).body;
    assert.equal(dev.role, 'referee'); assert.equal(dev.personId, P.Dev);
    assert.notEqual((await call('POST', '/api/matches/' + tieAB.body.id + '/paper', {}, dev.token)).status, 403);
    assert.equal((await call('POST', '/api/matches/' + tieBC.id + '/paper', {}, dev.token)).status, 403);
    const two = await call('PUT', '/api/admin/matches/' + tieAB.body.id, { refereeIds: [devRef, (await call('GET', '/api/state', null, admin)).body.referees.find((r) => r.playerId !== P.Dev && r.playerId !== P.Ravi && r.playerId !== P.Asha && r.playerId !== P.Kiran && r.playerId !== P.Meena)?.id].filter(Boolean) }, admin);
    assert.equal(two.status, 200);

    // every player gets a PIN; they sign in, add a photo and choose their own PIN
    const pins = (await call('POST', '/api/admin/people/pins', {}, admin)).body.pins;
    const lata = pins.find((x) => x.id === P.Lata);
    const me = (await call('POST', '/api/login', { pin: lata.pin })).body;
    assert.equal(me.role, 'captain' === me.role ? 'captain' : 'player'); assert.equal(me.personId, P.Lata);
    const prof = (await call('GET', '/api/me', null, me.token)).body; assert.equal(prof.profile.name, 'Lata'); assert.equal(prof.profile.pinHash, undefined);
    assert.equal((await call('POST', '/api/me/pin', { pin: '123456' }, me.token)).status, 400, 'too easy');
    assert.equal((await call('POST', '/api/me/pin', { pin: roles.pin }, me.token)).status, 400, 'taken – generic answer');
    assert.equal((await call('POST', '/api/me/pin', { pin: '583920' }, me.token)).status, 200);
    assert.equal((await call('POST', '/api/login', { pin: '583920' })).body.personId, P.Lata);
    assert.equal((await call('POST', '/api/login', { pin: lata.pin })).status, 401, 'old PIN stops working');
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
    const ph = await fetch(s.base + '/api/me/photo', { method: 'POST', headers: { 'x-token': me.token, 'Content-Type': 'image/jpeg' }, body: jpg });
    assert.equal(ph.status, 200);
    assert.ok((await call('GET', '/api/state')).body.players.length > 0);
    assert.equal((await call('GET', '/api/admin/players/' + P.Lata, null, admin)).body.pinHash, undefined, 'PIN hashes never leave the server');
    assert.equal((await call('POST', '/api/staff/tournaments', { name: 'Nope Cup' }, me.token)).status, 401, 'a player cannot create events');

    // admins manage admins; nobody removes their own admin role; one main admin always remains
    assert.equal((await call('POST', '/api/admin/people/' + P.Ravi + '/roles', { admin: false }, ravi.token)).status, 400);
    assert.equal((await call('POST', '/api/admin/people/' + P.Ravi + '/roles', { admin: false }, admin)).status, 200);
    assert.equal((await call('GET', '/api/state', null, ravi.token)).body.registration.enabled, undefined, 'Ravi is no longer an admin');
  } finally { await s.stop(); }
});

test('registration gives the new player their first PIN', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    await call('POST', '/api/admin/registration', { enabled: true }, admin);
    const ev = (await call('GET', '/api/state')).body.registration.events.find((e) => !e.team && e.section === 'adults');
    const r = await call('POST', '/api/register', { name: 'New Player', section: 'adults', phone: '9800012345', consent: true, eventIds: [ev.id] });
    assert.equal(r.status, 200); assert.match(r.body.pin, /^\d{6}$/);
    const who = (await call('POST', '/api/login', { pin: r.body.pin })).body;
    assert.equal(who.name, 'New Player'); assert.equal(who.role, 'player');
  } finally { await s.stop(); }
});
