'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { start } = require('./helpers');
const login = async (s) => (await s.call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;

/* Same layout as the community registration form (made-up people). */
const HEAD = ['Participant Name', 'Villa Number', 'Phone Number', 'Select Games to Participate [Badminton]', 'Select Games to Participate [Carrom]', 'Select Games to Participate [Chess]', 'Select Games to Participate [Table Tennis]', 'Category', 'Gender', 'Age'];
const ROWS = [
  ['Arun Test', 1, 9000000001, 'Yes', 'Yes', 'Yes', '', 'Seniors', 'Male', ''],
  ['meera test', 17, 9000000002, 'Yes', '', '', 'Yes', 'Seniors', 'Female', ''],
  ['KAVYA TEST ', 17, 9000000002, 'Yes', 'Yes', 'Yes', '', 'Under - 16', 'Female', 7],
  ['Neel Test', 19, 9000000003, '', 'Yes', '', '', 'Under - 16', 'Male', 11],
  ['Neel Test', 19, 9000000003, 'Yes', 'Yes', '', '', 'Under - 16', 'Male', 11],
  ['Idle Test', 92, 9000000004, '', '', '', '', 'Seniors', 'Male', ''],
];

test('community registration format: sport columns, category, villa, age, merge and re-upload updates', async () => {
  const s = await start();
  try {
    const { call } = s; const admin = await login(s);
    const ExcelJS = require('exceljs'); const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Form Responses 1');
    ws.addRow(HEAD); ROWS.forEach((r) => ws.addRow(r));
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    // entered earlier by hand without a phone, and a placeholder-phone entry: both must be updated, not duplicated
    const old1 = (await call('POST', '/api/admin/players', { name: 'Idle Test', section: 'adults' }, admin)).body;
    const old2 = (await call('POST', '/api/admin/players', { name: 'Meera Test', section: 'adults', phone: '9999999999' }, admin)).body;
    const post = (buf, path, q) => fetch(s.base + path + (q || ''), { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream' }, body: buf }).then((r) => r.json());

    const info = await post(xlsx, '/api/admin/import-inspect');
    const sh = info.sheets[0];
    assert.ok(sh.looksLikePlayers); assert.equal(sh.rows, 6);
    assert.deepEqual(sh.sportCols.map((x) => x.sport), ['badminton', 'carrom', 'chess', 'tt']);
    assert.equal(sh.map.section, 8); assert.equal(sh.map.villa, 2); assert.equal(sh.map.age, 10);

    const dry = await post(xlsx, '/api/admin/import-players', '?dry=1');
    assert.equal(dry.created, 3); assert.equal(dry.updated, 2); assert.equal(dry.merged, 1); assert.equal(dry.errors.length, 0);
    const r = await post(xlsx, '/api/admin/import-players');
    assert.equal(r.created, 3); assert.equal(r.updated, 2);

    const st = (await call('GET', '/api/state', null, admin)).body;
    const P = (n) => st.players.find((p) => p.name === n);
    const inEv = (pid, name) => st.events.find((e) => e.name === name).participantIds.includes(pid);
    const interested = (pid, name) => (st.events.find((e) => e.name === name).interestedIds || []).includes(pid);
    const arun = P('Arun Test'), meera = P('Meera Test')
    assert.equal(meera.id, old2.id); assert.equal(P('Idle Test').id, old1.id);
    const meeraPhone = (await call('GET', '/api/admin/players/' + meera.id, null, admin)).body.phone; assert.equal(meeraPhone, '9000000002', 'latest phone wins');
    assert.match((await call('GET', '/api/admin/players/' + meera.id, null, admin)).body.notes, /phone was 99•••••999/, 'old phone kept in notes, masked');
    const _x = 0, kavya = P('Kavya Test'), neel = P('Neel Test');
    assert.ok(arun && meera && kavya && neel && P('Idle Test'), 'names tidied, all imported');
    assert.equal(arun.section, 'adults'); assert.equal(kavya.section, 'kids');
    assert.ok(inEv(arun.id, 'Carrom') && inEv(arun.id, 'Chess'));
    assert.ok(interested(arun.id, 'Badminton – Team Event'), 'men: badminton goes to the team event interest list, not women’s doubles');
    assert.ok(!inEv(arun.id, "Badminton – Women's Doubles"));
    assert.ok(inEv(meera.id, "Badminton – Women's Doubles") && inEv(meera.id, 'Table Tennis'));
    assert.ok(inEv(kavya.id, 'Kids – Badminton') && inEv(kavya.id, 'Kids – Carrom') && inEv(kavya.id, 'Kids – Chess'));
    assert.ok(inEv(neel.id, 'Kids – Badminton') && inEv(neel.id, 'Kids – Carrom'), 'duplicate rows merged, games combined');
    const priv = (await call('GET', '/api/admin/players/' + kavya.id, null, admin)).body;
    assert.equal(priv.ageGroup, 'Age 7'); assert.equal(priv.affiliation, 'Villa 17'); assert.equal(priv.gender, 'F'); assert.equal(priv.phone, '9000000002');

    // the same sheet as CSV, with a changed villa and a new game: players are updated, not duplicated
    const csv = [HEAD, ...ROWS.map((x) => (x[0] === 'Arun Test' ? ['Arun Test', 2, 9000000099, 'Yes', '', 'Yes', 'Yes', 'Seniors', 'Male', ''] : /KAVYA/.test(x[0]) ? ['Kavya Test', 17, x[2], 'Yes', 'Yes', '', '', 'Under - 16', 'Female', 8] : x[0] === 'Neel Test' ? ['Neel Test', 19, x[2], '', 'Yes', '', '', 'Seniors', 'Male', 16] : x))]
      .map((row) => row.map((c) => (/[",]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n');
    const again = await post(Buffer.from(csv), '/api/admin/import-players');
    assert.equal(again.created, 0); assert.equal(again.updated, 5); assert.equal(again.changed, 3);
    const st2 = (await call('GET', '/api/state', null, admin)).body;
    assert.equal(st2.players.filter((p) => /Test$/.test(p.name)).length, 5, 'no duplicates on re-upload');
    assert.ok(st2.events.find((e) => e.name === 'Table Tennis').participantIds.includes(arun.id), 'new game added on update');
    const arunP = (await call('GET', '/api/admin/players/' + arun.id, null, admin)).body;
    assert.equal(arunP.affiliation, 'Villa 2', 'latest villa wins'); assert.equal(arunP.phone, '9000000099', 'new phone number recognised by name');
    assert.match(arunP.notes, /villa \/ dept was Villa 1/); assert.match(arunP.notes, /phone was 90•••••001/); assert.ok(!/9000000001/.test(arunP.notes), 'no full old number in notes'); assert.match(arunP.notes, /left Carrom/);
    assert.ok(!st2.events.find((e) => e.name === 'Carrom').participantIds.includes(arun.id), 'unticked game removed');
    assert.ok(!st2.events.find((e) => e.name === 'Kids – Chess').participantIds.includes(kavya.id), 'unticked kids game removed');
    assert.equal((await call('GET', '/api/admin/players/' + kavya.id, null, admin)).body.ageGroup, 'Age 8');
    const neel2 = st2.players.find((p) => p.id === neel.id);
    assert.equal(neel2.section, 'adults', 'child moved up to Seniors keeps the same profile');
    assert.ok(st2.events.find((e) => e.name === 'Carrom').participantIds.includes(neel.id) && !st2.events.find((e) => e.name === 'Kids – Carrom').participantIds.includes(neel.id));
    const idle = (await call('GET', '/api/admin/players/' + P('Idle Test').id, null, admin)).body;
    assert.equal(idle.phone, '9000000004', 'blank phone filled in'); assert.equal(idle.affiliation, 'Villa 92');
    const third = await post(Buffer.from(csv), '/api/admin/import-players'); assert.equal(third.changed, 0, 'same upload again changes nothing'); assert.equal(third.created, 0);

    // organizer can override which game a sport column means, or skip it
    const opts = { sheets: [{ index: 0, headerRow: 1, map: sh.map, sportMap: { 'badminton|adults': 'skip' } }] };
    const skip = await fetch(s.base + '/api/admin/import-players?dry=1', { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream', 'x-import-options': JSON.stringify(opts) }, body: xlsx }).then((x) => x.json());
    assert.equal(skip.warnings.length, 0);
  } finally { await s.stop(); }
});
