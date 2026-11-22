'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('🔔 notify: WhatsApp messages for the players of an upcoming match, staff only', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    const st0 = (await call('GET', '/api/state', null, admin)).body;
    const tt = st0.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const team = st0.events.find((e) => e.sideType === 'team' && e.section === 'adults');
    const P = {};
    for (const [n, ph] of [['Ravi Kumar', '98765 43210'], ['Asha', '+44 7700 900123'], ['Kiran', ''], ['Meena', '09876543211']]) P[n.split(' ')[0]] = (await call('POST', '/api/admin/players', { name: n, phone: ph }, admin)).body.id;
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: [P.Ravi, P.Asha, P.Kiran, P.Meena] }, admin);
    const mt = (await call('POST', '/api/admin/matches', { eventId: tt.id, sideA: [P.Ravi], sideB: [P.Kiran], court: 'Court 2', startsAt: '2026-12-05T10:30' }, admin)).body;

    // nobody signed in, or a plain player, cannot see the numbers
    assert.equal((await call('POST', '/api/staff/matches/' + mt.id + '/notify', {})).status, 401);

    const plan = (await call('POST', '/api/staff/matches/' + mt.id + '/notify', {}, admin)).body;
    assert.equal(plan.auto, false, 'no Cloud API configured in tests');
    assert.deepEqual(plan.recipients.map((r) => [r.name, r.phone]), [['Ravi Kumar', '919876543210']]);
    assert.deepEqual(plan.missing, ['Kiran']);
    assert.match(plan.recipients[0].text, /^Hi Ravi, /);
    assert.match(plan.recipients[0].text, /Court 2/);
    assert.match(plan.recipients[0].text, /#\/match\//);
    assert.match(plan.title, /#\d+/);

    // a custom message keeps the {name} / {link} placeholders per player
    const c = (await call('POST', '/api/staff/matches/' + mt.id + '/notify', { message: 'Hello {name}! {link}' }, admin)).body;
    assert.match(c.recipients[0].text, /^Hello Ravi! http/);

    // auto-send needs the Cloud API; marking the manual sends records it on the match
    assert.equal((await call('POST', '/api/staff/matches/' + mt.id + '/notify', { send: true }, admin)).status, 400);
    await call('POST', '/api/staff/matches/' + mt.id + '/notify', { mark: 1 }, admin);
    const after = (await call('GET', '/api/state', null, admin)).body.matches.find((x) => x.id === mt.id);
    assert.equal(after.notified.n, 1); assert.equal(after.notified.via, 'manual');

    // team match: every member of both teams is messaged; numbers normalised (+44, leading 0)
    const tA = (await call('POST', '/api/admin/teams', { name: 'A', memberIds: [P.Ravi, P.Asha] }, admin)).body.id;
    const tB = (await call('POST', '/api/admin/teams', { name: 'B', memberIds: [P.Kiran, P.Meena] }, admin)).body.id;
    await call('PUT', '/api/admin/events/' + team.id, { participantIds: [tA, tB] }, admin);
    const tie = (await call('POST', '/api/admin/matches', { eventId: team.id, sideA: [tA], sideB: [tB] }, admin)).body;
    const tp = (await call('POST', '/api/staff/matches/' + tie.id + '/notify', {}, admin)).body;
    assert.deepEqual(tp.recipients.map((r) => r.phone).sort(), ['447700900123', '919876543210', '919876543211']);
    assert.deepEqual(tp.missing, ['Kiran']);

    // once the match has started there is nothing to notify
    const ref = (await call('POST', '/api/admin/people/' + P.Meena + '/roles', { referee: 'referee' }, admin)).body;
    const rt = (await call('POST', '/api/login', { pin: ref.pin })).body.token;
    assert.equal((await call('POST', '/api/staff/matches/' + mt.id + '/notify', {}, rt)).status, 200, 'referees can notify');
    const r = await call('POST', '/api/matches/' + mt.id + '/ops', { ops: [{ type: 'point', s: 'A', inc: 1, cid: 'x1' }] }, rt);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await call('POST', '/api/staff/matches/' + mt.id + '/notify', {}, admin)).status, 409);
  } finally { await s.stop(); }
});
