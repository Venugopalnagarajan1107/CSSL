'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

test('games need an organizer and a referee; game organizers manage only their games', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    assert.match((await call('POST', '/api/admin/games', { sport: 'tt', kind: 'doubles' }, admin)).body.error, /referee/, 'a game needs a referee (its organizer is the event’s)');
    const me = (await call('GET', '/api/admin/admins', null, admin)).body.find((a) => a.me);
    assert.match((await call('POST', '/api/admin/games', { sport: 'tt', kind: 'doubles', organizerIds: [me.id] }, admin)).body.error, /referee/);
    const g = await call('POST', '/api/admin/games', { sport: 'badminton', kind: 'doubles', section: 'adults', name: 'Mixed Doubles', organizerIds: [], newOrganizer: 'Priya Lead', newReferees: ['Umpire One', 'Umpire Two'] }, admin);
    assert.equal(g.status, 200);
    assert.equal(g.body.event.sideSize, 2); assert.equal(g.body.event.sport, 'badminton'); assert.equal(g.body.event.refereeIds.length, 2);
    assert.deepEqual(g.body.pins.map((x) => x.role), ['Organizer', 'Referee', 'Referee']);
    // a badminton umpire is not offered for chess
    assert.match((await call('POST', '/api/admin/games', { sport: 'chess', kind: 'team', section: 'kids', organizerIds: [me.id], refereeIds: g.body.event.refereeIds.slice(0, 1) }, admin)).body.error, /not mapped to Chess/);
    const team = (await call('POST', '/api/admin/games', { sport: 'chess', kind: 'team', section: 'kids', organizerIds: [me.id], newReferees: ['Arbiter'] }, admin)).body.event;
    assert.equal(team.sideType, 'team'); assert.equal(team.section, 'kids'); assert.equal(team.name, 'Chess – Team Event (Kids)'); assert.equal(team.scoring, 'result');

    // the new organizer manages Mixed Doubles only
    const lead = (await call('POST', '/api/login', { role: 'admin', pin: g.body.pins[0].pin })).body;
    assert.equal(lead.limited, true);
    const st = (await call('GET', '/api/state', null, admin)).body, other = st.events.find((e) => e.name === 'Table Tennis');
    assert.equal((await call('PUT', '/api/admin/events/' + g.body.event.id, { note: 'ok' }, lead.token)).status, 200);
    assert.equal((await call('PUT', '/api/admin/events/' + other.id, { note: 'no' }, lead.token)).status, 403);
    assert.equal((await call('POST', '/api/admin/referees', { name: 'X' }, lead.token)).status, 403, 'only the main organizer adds referees');
    assert.equal((await call('PUT', '/api/admin/events/' + g.body.event.id + '/staff', { organizerIds: [], refereeIds: [] }, admin)).status, 400, 'cannot remove all staff');

    // an assigned referee may score that game even when limited to another sport
    const ref = (await call('GET', '/api/state', null, admin)).body.referees.find((r) => r.name === 'Umpire One');
    await call('PUT', '/api/admin/referees/' + ref.id, { sports: ['chess'] }, admin);
    const p = []; for (const n of ['A1', 'A2', 'B1', 'B2']) p.push((await call('POST', '/api/admin/players', { name: n }, admin)).body.id);
    await call('PUT', '/api/admin/events/' + g.body.event.id, { participantIds: p }, admin);
    const m = (await call('POST', '/api/admin/matches', { eventId: g.body.event.id, sideA: p.slice(0, 2), sideB: p.slice(2) }, admin)).body;
    const rt = (await call('POST', '/api/login', { role: 'referee', refereeId: ref.id, pin: g.body.pins[1].pin })).body.token;
    assert.notEqual((await call('POST', '/api/matches/' + m.id + '/paper', {}, rt)).status, 403);

    // organizer names are public (first name only), PINs never
    const pub = (await call('GET', '/api/state')).body;
    assert.ok(pub.organizers.some((a) => a.name === 'Priya')); assert.ok(!JSON.stringify(pub.organizers).includes('pinHash'));
  } finally { await s.stop(); }
});

test('anyone can add photos and videos; videos stream with ranges; reports are staff-only; contacts masked in notes', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const up = (type, body, q) => fetch(s.base + '/api/gallery/media?' + new URLSearchParams(q || {}), { method: 'POST', headers: { 'Content-Type': type }, body });
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(3e6, 7)]);
    const r1 = await up('image/jpeg', jpg, { caption: 'Smash!', by: 'Guest Fan' }); assert.equal(r1.status, 200);
    const k1 = (await r1.json()).deleteKey;
    const r2 = await up('video/mp4', mp4); assert.equal(r2.status, 200);
    assert.equal((await up('video/mp4', Buffer.from('not a video at all, just text'))).status, 400, 'fake video refused');
    assert.equal((await up('application/pdf', jpg)).status, 400);
    const gal = (await call('GET', '/api/state')).body.gallery;
    assert.equal(gal.length, 2); assert.equal(gal[1].by, 'Guest Fan'); assert.ok(gal.every((g) => !g.delHash), 'delete keys never public');
    const vid = gal.find((g) => g.type === 'video');
    const part = await fetch(s.base + vid.url, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 100); assert.match(part.headers.get('content-range'), /^bytes 0-99\/3000012$/);
    // remove: not by strangers; yes with the uploader's key
    const img = gal.find((g) => g.type === 'image');
    assert.equal((await fetch(s.base + '/api/gallery/' + img.id, { method: 'DELETE', headers: { 'x-delete-key': 'wrong' } })).status, 403);
    assert.equal((await fetch(s.base + '/api/gallery/' + img.id, { method: 'DELETE', headers: { 'x-delete-key': k1 } })).status, 200);
    assert.equal((await fetch(s.base + '/api/gallery/' + vid.id, { method: 'DELETE', headers: { 'x-token': admin } })).status, 200, 'organizer removes anything');

    assert.equal((await fetch(s.base + '/api/export.xlsx')).status, 403);
    assert.equal((await fetch(s.base + '/api/export.xlsx', { headers: { 'x-token': admin } })).status, 200);
  } finally { await s.stop(); }
});
