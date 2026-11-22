'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('one PIN per person: existing PINs carried over (admin first), every role on it, resets change the one PIN', async () => {
  const s = await start({ keepDir: true });
  let s2;
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const login = async (pin) => (await call('POST', '/api/login', { pin })).body;
    const P = {}; for (const n of ['Venu', 'Raghu', 'Asha', 'Bala']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;

    // older separate accounts: Venu had an admin PIN and a referee PIN; Raghu only a referee PIN
    const venuAdmin = (await call('POST', '/api/admin/admins', { name: 'Venu' }, admin)).body;
    const venuRef = (await call('POST', '/api/admin/referees', { name: 'Venu', pin: '48213', sports: ['tt'] }, admin)).body;
    const raghuRef = (await call('POST', '/api/admin/referees', { name: 'Raghu', pin: '57319', sports: ['tt'] }, admin)).body;
    const link = (type, id, pid) => call('POST', '/api/admin/people/link', { type, id, playerId: pid }, admin);
    await link('admin', venuAdmin.id, P.Venu); await link('referee', venuRef.id, P.Venu); await link('referee', raghuRef.id, P.Raghu);

    // Venu keeps the admin PIN – now with every role; the old referee PIN no longer works
    const v = await login(venuAdmin.pin);
    assert.equal(v.role, 'admin'); assert.equal(v.personId, P.Venu); assert.ok(v.refId, 'referee role on the same PIN');
    assert.equal((await call('POST', '/api/login', { pin: '48213' })).status, 401, 'second PIN retired');
    // Raghu keeps the referee PIN, now his person PIN
    const r = await login('57319'); assert.equal(r.personId, P.Raghu); assert.equal(r.role, 'referee');
    let people = (await call('GET', '/api/admin/people', null, admin)).body.people;
    assert.ok(people.find((x) => x.id === P.Venu).hasPin && people.find((x) => x.id === P.Raghu).hasPin);

    // a restart keeps it that way (the same rule runs on start and changes nothing more)
    await s.stop();
    s2 = await start({ dir: s.DIR, keepDir: true });
    assert.equal((await s2.call('POST', '/api/login', { pin: venuAdmin.pin })).body.personId, P.Venu);
    assert.equal((await s2.call('POST', '/api/login', { pin: '48213' })).status, 401);
    const admin2 = (await s2.call('POST', '/api/login', { pin: s.pin })).body.token;
    const c = s2.call;

    // new roles for someone from the player list reuse their PIN; someone without one gets one
    const st = (await c('GET', '/api/state', null, admin2)).body, T = st.tournaments.find((t) => t.kind !== 'friendly');
    const put = (await c('PUT', '/api/staff/tournaments/' + T.id, { organizerIds: T.organizerIds, refereeIds: T.refereeIds.length ? T.refereeIds : [raghuRef.id], newOrganizers: [{ playerId: P.Raghu }, { playerId: P.Asha }] }, admin2)).body;
    assert.deepEqual(put.pins.map((x) => [x.name, !!x.pin]), [['Raghu', false], ['Asha', true]]);
    const asha = (await c('POST', '/api/login', { pin: put.pins[1].pin })).body;
    assert.equal(asha.personId, P.Asha); assert.equal(asha.role, 'admin');
    const raghu2 = (await c('POST', '/api/login', { pin: '57319' })).body;
    assert.equal(raghu2.role, 'admin', 'Raghu: organizer now too, same PIN'); assert.ok(raghu2.refId);

    // "New PIN" for a linked admin changes the person's one PIN
    const np = (await c('PUT', '/api/admin/admins/' + venuAdmin.id, { resetPin: true }, admin2)).body.pin;
    assert.equal((await c('POST', '/api/login', { pin: venuAdmin.pin })).status, 401);
    assert.equal((await c('POST', '/api/login', { pin: np })).body.personId, P.Venu);
    // choosing your own PIN works for an admin sign-in that is not a player too
    const mainTok = admin2;
    assert.equal((await c('POST', '/api/me/pin', { pin: '583920' }, mainTok)).status, 200);
    assert.equal((await c('POST', '/api/login', { pin: '583920' })).body.role, 'admin');
  } finally { if (s2) await s2.stop(); else await s.stop(); require('fs').rmSync(s.DIR, { recursive: true, force: true }); }
});
