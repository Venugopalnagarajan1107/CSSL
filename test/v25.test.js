'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('guidelines per event and sport: upload a document or text, edit, copy, delete; organizers only', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    let st = (await call('GET', '/api/state', null, admin)).body;
    const T = st.tournaments.find((t) => t.kind !== 'friendly');
    const up = (body, type, tok) => fetch(s.base + '/api/staff/tournaments/' + T.id + '/guidelines/file', { method: 'POST', headers: { 'Content-Type': type, 'x-token': tok || '' }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

    // uploads: only organizers, only real PDF / DOCX / pictures
    assert.equal((await up(pdf, 'application/pdf')).status, 401);
    assert.equal((await up(Buffer.from('<html>not a pdf</html>'), 'application/pdf', admin)).status, 400);
    assert.equal((await up(Buffer.from('MZ...'), 'application/x-msdownload', admin)).status, 400);
    const f = (await up(pdf, 'application/pdf', admin)).body;
    assert.match(f.url, /^\/uploads\/\w+\.pdf$/); assert.equal(f.kind, 'pdf');
    const served = await fetch(s.base + f.url);
    assert.equal(served.headers.get('content-type'), 'application/pdf'); assert.ok(!/sandbox/.test(served.headers.get('content-security-policy') || ''), 'PDF opens in the browser viewer');

    // add: table tennis with the document; general with text only; nothing at all is refused
    assert.equal((await call('POST', '/api/staff/tournaments/' + T.id + '/guidelines', { sport: 'tt' }, admin)).status, 400);
    const g1 = (await call('POST', '/api/staff/tournaments/' + T.id + '/guidelines', { sport: 'tt', title: 'TT rules', file: { ...f, name: 'tt-rules.pdf' } }, admin)).body;
    const g2 = (await call('POST', '/api/staff/tournaments/' + T.id + '/guidelines', { sport: 'general', text: 'Report 15 minutes early.' }, admin)).body;
    assert.equal(g1.sport, 'tt'); assert.equal(g2.file, null);
    assert.equal((await call('POST', '/api/staff/tournaments/' + T.id + '/guidelines', { sport: 'tt', file: { url: '/etc/passwd', name: 'x' }, text: '' }, admin)).status, 400, 'only our own uploads');

    // everyone sees them (no sign-in)
    let pub = (await call('GET', '/api/state')).body;
    const Tp = pub.tournaments.find((t) => t.id === T.id);
    assert.deepEqual(Tp.guidelines.map((g) => g.sport).sort(), ['general', 'tt']);

    // a player cannot change them; a sport lead who does not organize the event cannot either
    const pid = (await call('POST', '/api/admin/players', { name: 'Plain Player' }, admin)).body.id;
    const pin = (await call('POST', '/api/admin/people/' + pid + '/pin', {}, admin)).body.pin;
    const pt = (await call('POST', '/api/login', { pin })).body.token;
    assert.equal((await call('POST', '/api/staff/tournaments/' + T.id + '/guidelines', { sport: 'chess', text: 'x' }, pt)).status, 403);
    const lead = (await call('POST', '/api/admin/admins', { name: 'Lead', sports: ['chess'] }, admin)).body;
    const lt = (await call('POST', '/api/login', { role: 'admin', pin: lead.pin })).body.token;
    assert.equal((await call('PUT', '/api/staff/tournaments/' + T.id + '/guidelines/' + g1.id, { text: 'hack' }, lt)).status, 403);

    // edit: replace text, drop the document only if text remains
    assert.equal((await call('PUT', '/api/staff/tournaments/' + T.id + '/guidelines/' + g1.id, { file: null }, admin)).status, 400);
    assert.equal((await call('PUT', '/api/staff/tournaments/' + T.id + '/guidelines/' + g1.id, { text: 'Best of 3, 11 points.' }, admin)).body.text, 'Best of 3, 11 points.');

    // a new event copies them; changing the copy leaves the original alone
    const ref = st.referees.length ? st.referees[0].id : null;
    const cup = (await call('POST', '/api/staff/tournaments', { name: 'Next Cup', ...(ref ? { refereeIds: [ref] } : { newReferees: ['R'] }), games: [{ sport: 'tt' }] }, admin)).body.tournament;
    assert.equal((await call('POST', '/api/staff/tournaments/' + cup.id + '/guidelines/copy', { from: T.id }, admin)).body.copied, 2);
    pub = (await call('GET', '/api/state')).body;
    const copied = pub.tournaments.find((t) => t.id === cup.id).guidelines;
    assert.equal(copied.length, 2); assert.ok(copied.every((g) => g.id !== g1.id && g.id !== g2.id));
    await call('DELETE', '/api/staff/tournaments/' + cup.id + '/guidelines/' + copied[0].id, null, admin);
    pub = (await call('GET', '/api/state')).body;
    assert.equal(pub.tournaments.find((t) => t.id === cup.id).guidelines.length, 1);
    assert.equal(pub.tournaments.find((t) => t.id === T.id).guidelines.length, 2, 'original untouched');
  } finally { await s.stop(); }
});
