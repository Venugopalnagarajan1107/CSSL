'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('my sign-in picks up roles given after signing in (player / referee views for an admin)', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body;
    assert.equal(admin.personId, '');
    const pid = (await call('POST', '/api/admin/players', { name: 'Venu' }, admin.token)).body.id;
    await call('POST', '/api/admin/people/' + pid + '/roles', { referee: 'referee', sports: ['tt'] }, admin.token);
    // the main admin links their own sign-in to their player profile (the Dashboard's "Which player are you?")
    assert.equal((await call('POST', '/api/admin/people/link', { type: 'admin', id: admin.adminId, playerId: pid }, admin.token)).status, 200);
    const me = (await call('GET', '/api/me', null, admin.token)).body;
    assert.equal(me.personId, pid, 'now a player too'); assert.ok(me.refId, 'and a referee'); assert.equal(me.role, 'admin');
    // the same session keeps working with the new roles (no new sign-in needed)
    assert.equal((await call('GET', '/api/me', null, admin.token)).body.personId, pid);
  } finally { await s.stop(); }
});
