'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;
const staff = async (s, admin, name, kind, pin) => {
  const r = (await s.call('POST', '/api/admin/referees', { name, kind, pin }, admin)).body;
  return (await s.call('POST', '/api/login', { role: 'referee', refereeId: r.id, pin })).body;
};

test('stage 1: nothing personal is public, staff see full names, only referees score', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const mk = async (b) => (await call('POST', '/api/admin/players', { section: 'adults', ...b }, admin)).body;
    const a = await mk({ name: 'Rahul Kumar', gender: 'M', phone: '9876543210', email: 'rahul@example.com', dob: '1990-01-01', bio: 'private bio', ageGroup: 'Open' });
    const b = await mk({ name: 'Rahul Sharma', gender: 'M' }); const c = await mk({ name: 'Meera Rao', gender: 'F' });
    const kid = await mk({ name: 'Anaya Nair Iyer', section: 'kids', gender: 'F', ageGroup: 'Under-10', photo: '/uploads/k.jpg', guardianName: 'Parent Name', guardianPhone: '9000000000' });

    // public feed
    const raw = JSON.stringify((await call('GET', '/api/state')).body);
    for (const secret of ['9876543210', 'rahul@example.com', '1990-01-01', 'private bio', 'Kumar', 'Sharma', 'Iyer', 'Parent Name', '9000000000', '/uploads/k.jpg', 'Under-10'])
      assert.ok(!raw.includes(secret), 'public feed must not contain ' + secret);
    const pub = (await call('GET', '/api/state')).body.players;
    assert.equal(pub.find((p) => p.id === c.id).name, 'Meera');
    assert.equal(pub.find((p) => p.id === kid.id).name, 'Anaya');
    assert.deepEqual(new Set([pub.find((p) => p.id === a.id).name, pub.find((p) => p.id === b.id).name]), new Set(['Rahul K.', 'Rahul S.']), 'same first names get a last initial');

    // referee and organizer views
    const chief = await staff(s, admin, 'Chitra Chief', 'chief', '5501');
    const ref = await staff(s, admin, 'Ravi Referee', 'referee', '5502');
    const vol = await staff(s, admin, 'Vera Volunteer', 'volunteer', '5503');
    assert.equal(chief.kind, 'chief'); assert.equal(vol.kind, 'volunteer');
    const refView = (await call('GET', '/api/state', null, ref.token)).body;
    assert.equal(refView.players.find((p) => p.id === a.id).name, 'Rahul Kumar', 'referees see full names');
    assert.ok(!JSON.stringify(refView).includes('9876543210') && !JSON.stringify(refView).includes('rahul@example.com'), 'referees do not see contact details');
    const adminView = (await call('GET', '/api/state', null, admin)).body.players.find((p) => p.id === a.id);
    assert.equal(adminView.name, 'Rahul Kumar'); assert.equal(adminView.bio, 'private bio');

    // scoring is referee-only
    const st = (await call('GET', '/api/state')).body, ev = st.events.find((e) => e.name === 'Table Tennis');
    await call('PUT', '/api/admin/events/' + ev.id, { participantIds: [a.id, b.id] }, admin);
    const m = (await call('POST', '/api/admin/matches', { eventId: ev.id, sideA: [a.id], sideB: [b.id] }, admin)).body;
    const op = (tok, extra) => call('POST', '/api/matches/' + m.id + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'x' + Math.random() }], ...(extra || {}) }, tok);
    assert.equal((await op(admin)).status, 403, 'organizer cannot score');
    assert.equal((await op(vol.token)).status, 403, 'volunteer cannot score');
    assert.equal((await op('')).status, 401, 'anonymous cannot score');
    assert.equal((await op(ref.token)).status, 200, 'referee can score');
    assert.equal((await call('POST', '/api/matches/' + m.id + '/ops', { ops: [{ type: 'result', result: 'A', cid: 'fin' }], force: true }, chief.token)).status, 200);
    // corrections and resets: chief referee only
    assert.equal((await call('POST', '/api/admin/matches/' + m.id + '/scores', { games: [{ a: 11, b: 5 }] }, ref.token)).status, 403);
    assert.equal((await call('POST', '/api/admin/matches/' + m.id + '/scores', { games: [{ a: 11, b: 5 }] }, admin)).status, 403);
    assert.equal((await call('POST', '/api/admin/matches/' + m.id + '/scores', { games: [{ a: 11, b: 5 }, { a: 11, b: 6 }] }, chief.token)).status, 200);
    // audit shows who and the old and new score
    const au = (await call('GET', '/api/admin/audit?matchId=' + m.id, null, admin)).body;
    assert.ok(au.some((x) => x.who === 'Chitra Chief' && /→/.test(x.detail)), 'audit keeps old → new score');
    // push text uses first names only
    assert.ok(!JSON.stringify(au).includes('9876543210'));
  } finally { await s.stop(); }
});

test('stage 1: sport leads manage only their own sport', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const lead = (await call('POST', '/api/admin/admins', { name: 'Chess Lead', sports: ['chess'] }, admin)).body;
    const lt = (await call('POST', '/api/login', { role: 'admin', pin: lead.pin })).body;
    assert.deepEqual(lt.sports, ['chess']);
    const st = (await call('GET', '/api/state', null, lt.token)).body;
    const chess = st.events.find((e) => e.sport === 'chess' && e.section === 'adults'), tt = st.events.find((e) => e.sport === 'tt' && e.section === 'adults');
    assert.equal((await call('PUT', '/api/admin/events/' + chess.id, { name: chess.name, note: 'ok' }, lt.token)).status, 200);
    assert.equal((await call('PUT', '/api/admin/events/' + tt.id, { name: tt.name, note: 'x' }, lt.token)).status, 403, 'other sport blocked');
    assert.equal((await call('POST', '/api/admin/admins', { name: 'Evil' }, lt.token)).status, 403, 'cannot add admins');
    assert.equal((await call('POST', '/api/admin/tournament', { name: 'Hijack' }, lt.token)).status, 403, 'cannot change tournament settings');
    assert.equal((await call('POST', '/api/admin/referees', { name: 'R' }, lt.token)).status, 403, 'cannot manage referees');
  } finally { await s.stop(); }
});
