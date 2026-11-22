'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');

test('upload fixtures into one game: no Game column needed, short names, duplicates skipped, scores only from a chief referee', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    let st = (await call('GET', '/api/state', null, admin)).body;
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const T = st.tournaments.find((t) => t.id === tt.tid);
    const P = {}; for (const n of ['Srinivasan Thoyyeti', 'Raja', 'Manjesh', 'Ravi Kumar', 'Ravi Shankar']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;
    await call('POST', '/api/admin/tournaments/' + T.id + '/roster', { add: Object.values(P) }, admin);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: Object.values(P) }, admin);
    const up = (body, tok, dry) => fetch(s.base + '/api/admin/events/' + tt.id + '/import-fixtures' + (dry ? '?dry=1' : ''), { method: 'POST', headers: { 'x-token': tok, 'Content-Type': 'application/octet-stream' }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const csv = (rows) => Buffer.from(rows.map((r) => r.map((x) => '"' + x + '"').join(',')).join('\n'));
    const sheet = csv([
      ['Player A', 'Player B', 'Date', 'Time', 'Court', 'Score'],
      ['Srinivasan', 'Raja', '29/11/2026', '10:30 AM', 'Table 1', '11-5, 11-8'],     // short name
      ['Manjesh', 'Raja', '', '', '', ''],
      ['Ravi', 'Manjesh', '', '', '', ''],                                         // ambiguous: Ravi Kumar or Ravi Shankar
      ['Nobody Here', 'Raja', '', '', '', ''],
    ]);

    // the template lists this game's players
    const tpl = await fetch(s.base + '/api/admin/events/' + tt.id + '/fixtures-template.xlsx', { headers: { 'x-token': admin } });
    assert.equal(tpl.status, 200);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await tpl.arrayBuffer()));
    assert.ok(wb.worksheets[1].getColumn(1).values.includes('Srinivasan Thoyyeti'));

    // preview changes nothing; an admin who is not a chief referee gets the fixtures, not the score
    const dry = (await up(sheet, admin, true)).body;
    assert.equal(dry.made, 2); assert.equal(dry.errors.length, 2); assert.equal(dry.scored, 0); assert.equal(dry.scoresSkipped, 1);
    assert.match(dry.errors.map((e) => e.error).join(' | '), /could be Ravi Kumar or Ravi Shankar/);
    assert.match(dry.errors.map((e) => e.error).join(' | '), /not registered for this game/);
    assert.equal((await call('GET', '/api/state', null, admin)).body.matches.length, 0, 'preview saved nothing');
    const r = (await up(sheet, admin)).body; assert.equal(r.made, 2);
    st = (await call('GET', '/api/state', null, admin)).body;
    const first = st.matches.find((m) => m.sideA[0] === P['Srinivasan Thoyyeti']);
    assert.equal(first.startsAt, '2026-11-29T10:30'); assert.equal(first.court, 'Table 1'); assert.equal((first.log || []).length, 0);
    // uploading the same sheet again does not duplicate
    assert.equal((await up(sheet, admin)).body.existing, 2);

    // a main admin who is also chief referee uploads results too
    const pid = (await call('POST', '/api/admin/players', { name: 'Chief Person' }, admin)).body.id;
    const roles = (await call('POST', '/api/admin/people/' + pid + '/roles', { admin: true, referee: 'chief' }, admin)).body;
    const chief = (await call('POST', '/api/login', { pin: roles.pin })).body.token;
    const r2 = (await up(csv([['Player A', 'Player B', 'Score'], ['Raja', 'Ravi Kumar', '11-7, 9-11, 11-5'], ['Manjesh', 'Ravi Shankar', '11-2, 4-11']]), chief)).body;
    assert.equal(r2.made, 2); assert.equal(r2.scored, 2, 'a 1-1 sheet is a match in progress');
    st = (await call('GET', '/api/state', null, admin)).body;
    const E = require('../public/engine.js');
    const done = st.matches.find((m) => m.sideA[0] === P.Raja && m.sideB[0] === P['Ravi Kumar']);
    assert.equal(E.derive(done, st.events.find((e) => e.id === tt.id)).status, 'completed');
    const half = st.matches.find((m) => m.sideA[0] === P.Manjesh && m.sideB[0] === P['Ravi Shankar']);
    assert.equal(E.derive(half, st.events.find((e) => e.id === tt.id)).status, 'live');
    const bad = (await up(csv([['Player A', 'Player B', 'Score'], ['Srinivasan', 'Ravi Kumar', '11-30']]), chief, true)).body;
    assert.match(bad.warnings[0].error, /score not entered/);

    // a sheet with a Game column: rows for another game are skipped
    const r3 = (await up(csv([['Game', 'Player A', 'Player B'], ['Table Tennis', 'Raja', 'Manjesh'], ['Chess', 'Raja', 'Ravi Kumar']]), admin, true)).body;
    assert.match(r3.errors[0].error, /another game/);
    // no Player A / Player B columns
    assert.equal((await up(csv([['Name', 'Phone'], ['x', '1']]), admin)).status, 400);
    // a sport lead for chess cannot upload into table tennis
    const lead = (await call('POST', '/api/admin/admins', { name: 'Chess Lead', sports: ['chess'] }, admin)).body;
    const lt = (await call('POST', '/api/login', { role: 'admin', pin: lead.pin })).body.token;
    assert.equal((await up(sheet, lt, true)).status, 403);
  } finally { await s.stop(); }
});
