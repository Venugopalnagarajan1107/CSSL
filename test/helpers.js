'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function start(opts) {
  opts = opts || {};
  const PORT = 10000 + Math.floor(Math.random() * 40000);
  const DIR = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'tour2-'));
  const base = 'http://localhost:' + PORT;
  let out = '';
  const proc = spawn('node', [path.join(__dirname, '..', 'server.js'), ...(opts.args || [])], { env: { ...process.env, PORT, DATA_DIR: DIR, ...(opts.env || {}) } });
  proc.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 80 && !/Admin PIN/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const pin = (/Admin PIN\s*:\s*(\d+)/.exec(out) || [])[1];
  const call = async (method, url, body, token, headers) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'x-token': token || '', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (e) { /* none */ }
    return { status: r.status, body: j };
  };
  const stop = () => new Promise((resolve) => { proc.once('exit', () => { if (!opts.keepDir) fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 }); resolve(); }); proc.kill(); });
  const settle = (ms) => new Promise((r) => setTimeout(r, ms || 400));   /* saves are coalesced (150 ms) */
  return { base, DIR, pin, call, stop, settle, out: () => out, proc };
}
/* Only referees change scores: a ready-made chief referee for tests that score matches. */
async function chiefTok(S, admin, kind) {
  const r = (await S.call('POST', '/api/admin/referees', { name: 'Chief Test', kind: kind || 'chief', pin: '5599' }, admin)).body;
  return (await S.call('POST', '/api/login', { role: 'referee', refereeId: r.id, pin: '5599' })).body.token;
}
module.exports = { start, chiefTok };
