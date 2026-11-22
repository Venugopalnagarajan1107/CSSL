'use strict';
const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { start } = require('./helpers');
const D = require('../lib/doc-import.js');

const run = (t) => '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r>';
const para = (t) => '<w:p>' + run(t) + '</w:p>';
const cell = (t) => '<w:tc><w:tcPr/>' + para(t) + '</w:tc>';
async function docx(body) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  z.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="w"><w:body>' + body + '</w:body></w:document>');
  return z.generateAsync({ type: 'nodebuffer' });
}
async function pptx(slides) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  slides.forEach((x, i) => z.file('ppt/slides/slide' + (i + 1) + '.xml', '<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>' + x + '</p:spTree></p:cSld></p:sld>'));
  return z.generateAsync({ type: 'nodebuffer' });
}
const ap = (t) => '<a:p><a:r><a:t>' + t + '</a:t></a:r></a:p>';

test('fixture reader: tables with headers, "vs" lines with date / time / table', () => {
  const f = D.rowToFixture(['Match 3: Srinivasan vs Raghu – 29/11/2026 11:15 Table 2'], null);
  assert.deepEqual([f.a, f.b, f.date, f.time, f.court], ['Srinivasan', 'Raghu', '29/11/2026', '11:15', 'Table 2']);
  assert.equal(D.rowToFixture(['Venue: clubhouse'], null), null);
  const g = D.rowToFixture(['1', 'Raja v. Manjesh', '10:30 AM', 'Court 1'], null);
  assert.deepEqual([g.a, g.b, g.time, g.court], ['Raja', 'Manjesh', '10:30 AM', 'Court 1']);
  const S = require('../lib/sheet-import.js');
  assert.deepEqual(['4 pm', '10:30 AM', '12 am', 'Table 4'].map(S.timeOf), ['16:00', '10:30', '00:00', '']);
  const k = D.rowToFixture(['Kiran vs Ravi Kumar 12:00 PM'], null); assert.deepEqual([k.b, k.time], ['Ravi Kumar', '12:00 PM']);
});

test('upload fixtures from Word and PowerPoint; pictures / PDFs become fixture charts', async () => {
  const s = await start();
  try {
    const { call } = s;
    const admin = (await call('POST', '/api/login', { pin: s.pin })).body.token;
    let st = (await call('GET', '/api/state', null, admin)).body;
    const tt = st.events.find((e) => e.name === 'Table Tennis' && e.section === 'adults');
    const P = {}; for (const n of ['Raja', 'Manjesh', 'Srinivasan Thoyyeti', 'Raghunath Babu']) P[n] = (await call('POST', '/api/admin/players', { name: n }, admin)).body.id;
    await call('POST', '/api/admin/tournaments/' + tt.tid + '/roster', { add: Object.values(P) }, admin);
    await call('PUT', '/api/admin/events/' + tt.id, { participantIds: Object.values(P) }, admin);
    const up = (body, dry) => fetch(s.base + '/api/admin/events/' + tt.id + '/import-fixtures' + (dry ? '?dry=1' : ''), { method: 'POST', headers: { 'x-token': admin, 'Content-Type': 'application/octet-stream' }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));

    // Word: a table with headers plus a loose "vs" line
    const w = await docx(para('CS Table Tennis – fixtures') + '<w:p/>' +
      '<w:tbl><w:tblPr/><w:tr>' + cell('Player A') + cell('Player B') + cell('Time') + cell('Table') + '</w:tr><w:tr>' + cell('Raja') + cell('Manjesh') + cell('10:30 AM') + cell('T1') + '</w:tr></w:tbl>' +
      para('Match 3: Srinivasan vs Raghunath – 29/11/2026 11:15 Table 2') + para('Venue: clubhouse'));
    const dw = (await up(w, true)).body;
    assert.equal(dw.source, 'docx'); assert.equal(dw.made, 2, JSON.stringify(dw));
    assert.equal((await up(w)).body.made, 2);
    st = (await call('GET', '/api/state', null, admin)).body;
    const m2 = st.matches.find((m) => m.sideA[0] === P['Srinivasan Thoyyeti']);
    assert.equal(m2.startsAt, '2026-11-29T11:15'); assert.equal(m2.court, 'Table 2');
    assert.equal(st.matches.find((m) => m.sideA[0] === P.Raja).court, 'T1');

    // PowerPoint: a slide table without headers and a slide of lines
    const p = await pptx(['<a:tbl><a:tr><a:tc><a:txBody>' + ap('Raja vs Srinivasan') + '</a:txBody></a:tc><a:tc><a:txBody>' + ap('12:00 PM') + '</a:txBody></a:tc></a:tr></a:tbl>', ap('Manjesh vs Raghunath') + ap('Thank you!')]);
    const dp = (await up(p)).body;
    assert.equal(dp.source, 'pptx'); assert.equal(dp.made, 2, JSON.stringify(dp));

    // nothing readable / a picture / a PDF -> offered as a fixture chart
    assert.equal((await up(await docx(para('Hello')))).body.chart, true);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4d50000000049454e44ae426082', 'hex');
    assert.equal((await up(png)).body.chart, true);
    assert.equal((await up(Buffer.from('%PDF-1.4 x'))).body.chart, true);

    // fixture charts: attach (checked), shown to everyone, kept when the game settings are saved, removable
    const attach = (body, type, name) => fetch(s.base + '/api/admin/events/' + tt.id + '/fixture-docs?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'x-token': admin, 'Content-Type': type }, body }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const c1 = (await attach(png, 'image/png', 'schedule.png')).body; assert.equal(c1.kind, 'image');
    const c2 = (await attach(p, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'fixtures.pptx')).body; assert.equal(c2.kind, 'pptx');
    assert.equal((await attach(Buffer.from('not a pdf'), 'application/pdf', 'x.pdf')).status, 400);
    assert.equal((await attach(png, 'application/x-msdownload', 'x.exe')).status, 400);
    const dl = await fetch(s.base + c2.url); assert.match(dl.headers.get('content-disposition') || '', /attachment/);
    await call('PUT', '/api/admin/events/' + tt.id, { note: 'Best of 3' }, admin);
    let pub = (await call('GET', '/api/state')).body;
    assert.deepEqual(pub.events.find((e) => e.id === tt.id).fixtureDocs.map((d) => d.name), ['schedule.png', 'fixtures.pptx']);
    await call('DELETE', '/api/admin/events/' + tt.id + '/fixture-docs/' + c1.id, null, admin);
    pub = (await call('GET', '/api/state')).body;
    assert.equal(pub.events.find((e) => e.id === tt.id).fixtureDocs.length, 1);
    assert.equal((await fetch(s.base + '/api/admin/events/' + tt.id + '/fixture-docs?name=x', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })).status, 401);
  } finally { await s.stop(); }
});
