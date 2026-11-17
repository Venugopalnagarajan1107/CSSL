'use strict';
/* Simulated venue crowd:  node test/load.js [viewers=500] [seconds=20]
   - N phones hold the live connection and refetch the state after every update (like the real app)
   - 8 referees each enter ~2 points/second on their own match
   Prints latency percentiles, errors and server memory.  Not part of `npm test`. */
const http = require('node:http');
const { start } = require('./helpers');
const N = Number(process.argv[2]) || 500, SECS = Number(process.argv[3]) || 20;
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

(async () => {
  const s = await start();
  const call = s.call;
  const admin = (await call('POST', '/api/login', { role: 'admin', pin: s.pin })).body.token;
  const tt = (await call('GET', '/api/state')).body.events.find((e) => e.name === 'Table Tennis');
  const ids = []; for (let i = 0; i < 24; i++) ids.push((await call('POST', '/api/admin/players', { name: 'Player ' + i }, admin)).body.id);
  await call('PUT', '/api/admin/events/' + tt.id, { participantIds: ids }, admin);
  await call('POST', '/api/admin/events/' + tt.id + '/generate', {}, admin);
  const refs = [];
  for (let i = 0; i < 8; i++) { const r = (await call('POST', '/api/admin/referees', { name: 'Ref ' + i }, admin)).body; refs.push((await call('POST', '/api/login', { role: 'referee', refereeId: r.id, pin: r.pin })).body.token); }
  const matches = (await call('GET', '/api/state')).body.matches.slice(0, 8);

  const lat = [], opLat = []; let errs = 0, fetches = 0, events = 0, bytes = 0;
  const get = (ip) => new Promise((resolve) => {
    const t0 = performance.now();
    http.get(s.base + '/api/state', { agent, headers: { 'x-forwarded-for': ip, 'accept-encoding': 'gzip' } }, (res) => {
      res.on('data', (c) => (bytes += c.length)); res.on('end', () => { lat.push(performance.now() - t0); fetches++; if (res.statusCode !== 200 && res.statusCode !== 304) errs++; resolve(); });
    }).on('error', () => { errs++; resolve(); });
  });
  const viewers = [];
  for (let i = 0; i < N; i++) {
    const ip = '10.' + (i >> 8) + '.' + (i & 255) + '.7';   /* ~distinct phones; the server believes the proxy header on loopback */
    const req = http.get(s.base + '/api/stream', { agent, headers: { 'x-forwarded-for': ip } }, (res) => {
      if (res.statusCode !== 200) { errs++; return; }
      let pend = false;
      res.on('data', () => { events++; if (pend) return; pend = true; setTimeout(() => { pend = false; get(ip); }, 150 + Math.random() * 600); });
    });
    req.on('error', () => { errs++; }); viewers.push(req);
  }
  await new Promise((r) => setTimeout(r, 1500));
  const rss0 = process.memoryUsage().rss;
  const end = Date.now() + SECS * 1000; let seq = 0;
  await Promise.all(refs.map(async (tok, i) => {
    while (Date.now() < end) {
      const t0 = performance.now();
      const r = await call('POST', `/api/matches/${matches[i].id}/ops`, { ops: [{ type: 'point', s: seq++ % 2 ? 'A' : 'B', inc: 1, cid: 'c' + i + '-' + seq }] }, tok);
      opLat.push(performance.now() - t0); if (r.status !== 200) errs++;
      await new Promise((r2) => setTimeout(r2, 500));
    }
  }));
  await new Promise((r) => setTimeout(r, 1500));
  const pct = (a, p) => (a.slice().sort((x, y) => x - y)[Math.floor(a.length * p)] || 0).toFixed(0);
  let rssKb = 0; try { rssKb = Number(require('node:fs').readFileSync('/proc/' + s.proc.pid + '/status', 'utf8').match(/VmRSS:\s+(\d+)/)[1]); } catch (e) { /* not linux */ }
  console.log(`viewers=${N} seconds=${SECS}`);
  console.log(`state fetches: ${fetches} (p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, p99 ${pct(lat, 0.99)} ms)  ~${(bytes / 1e6).toFixed(1)} MB sent`);
  console.log(`scoring ops : ${opLat.length} (p50 ${pct(opLat, 0.5)} ms, p95 ${pct(opLat, 0.95)} ms, max ${pct(opLat, 1 - 1e-9)} ms)`);
  console.log(`push events delivered: ${events}   errors: ${errs}   server memory: ${(rssKb / 1024).toFixed(0)} MB`);
  viewers.forEach((r) => r.destroy()); await s.stop();
  process.exit(errs ? 1 : 0);
})();
