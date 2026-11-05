// Normalisasi semua jurnal ke satu skema + penilaian ulang seragam (trade-sim.mjs, aturan dasar).
// Keluaran: data/signals.json. Hanya baris yang SUDAH final (TP/SL/kedaluwarsa/tidak terisi) disimpan di
// data/grade-cache.json; baris OPEN dinilai ulang tiap run.
// Uji: BINANCE_BASE=http://127.0.0.1:PORT node scripts/grade.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gradeTrade, mapK, H1 } from './trade-sim.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const RAW = path.join(ROOT, 'data/raw');
const HOSTS = process.env.BINANCE_BASE ? [process.env.BINANCE_BASE] : cfg.binance_hosts;
const NOW = Date.now();
const sha = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Binance ----------
let hostIdx = 0;
async function bj(p) {
  let last;
  for (let t = 0; t < HOSTS.length; t++) {
    const h = HOSTS[(hostIdx + t) % HOSTS.length];
    for (let a = 0; a < 3; a++) {
      try {
        const r = await fetch(`${h}/api/v3/${p}`, { signal: AbortSignal.timeout(20000) });
        if (r.status === 400) { const b = await r.text(); const e = new Error('INVALID_SYMBOL ' + b.slice(0, 80)); e.invalid = /-1121|Invalid symbol/i.test(b); throw Object.assign(e, { final: true }); }
        if (r.status === 429 || r.status === 418) { await sleep(2000 * (a + 1)); continue; }
        if (!r.ok) throw new Error(`${h} HTTP ${r.status}`);
        hostIdx = (hostIdx + t) % HOSTS.length;
        return await r.json();
      } catch (e) { if (e.final) throw e; last = e; await sleep(400 * (a + 1)); }
    }
  }
  throw last || new Error('Binance tidak terjangkau');
}

// ---------- normalisasi ----------
const STATUS = { TP: 'TP', SL: 'SL', kedaluwarsa: 'KEDALUWARSA_TERISI', 'tidak terisi': 'TIDAK_TERISI', menunggu: 'OPEN', NO_TRADE: 'NO_TRADE', 'tidak valid': 'TIDAK_VALID' };
const num = x => (x === null || x === undefined || x === '' ? NaN : +x);

export function normalize(mesin, r) {
  const aset = r.aset ?? r.symbol ?? null, arah = r.arah ?? r.side ?? null;
  const row = {
    id: r.id ?? null, mesin: mesin.id, aset, arah,
    entry: num(r.entry), sl: num(r.sl), tp: num(r.tp), t: num(r.t), due: num(r.due),
    status_mesin: mesin.tanpa_hasil ? null : (STATUS[r.hasil] ?? null),
    R_mesin: Number.isFinite(num(r.R)) && r.R !== '' ? +r.R : null,
    sealed: mesin.chain === 'crypto' ? !!r.h : !!r.fwd,
    engine: r.engine ?? null, agen: r.agen ?? null, seq: r.seq ?? null,
  };
  if (mesin.id === 'crypto') Object.assign(row, { kind: r.kind ?? null, tipe: r.tipe ?? null, mode: r.mode ?? null, tf: r.tf ?? null, revisi: Array.isArray(r.rev) ? r.rev.length : 0 });
  if (mesin.id === 'tnv2c2' && r.trig) Object.assign(row, { kind: r.trig, grade: r.grade ?? null, score: r.score ?? null });
  return row;
}

// Alasan baris tidak bisa dinilai. null = valid.
export function invalidReason(x) {
  if (!x.aset || typeof x.aset !== 'string') return 'simbol_kosong';
  if (x.arah !== 'LONG' && x.arah !== 'SHORT') return 'arah_tidak_valid';
  if (![x.entry, x.sl, x.tp, x.t, x.due].every(Number.isFinite)) return 'angka_tidak_valid';
  if (!(x.due > x.t)) return 'due_sebelum_t';
  const L = x.arah === 'LONG';
  if (L ? !(x.sl < x.entry && x.tp > x.entry) : !(x.sl > x.entry && x.tp < x.entry)) return 'urutan_entry_sl_tp_salah';
  return null;
}

export const sigOf = x => sha([x.aset, x.arah, x.entry, x.sl, x.tp, x.t, x.due].join('|'));

// ---------- penilaian ----------
export async function gradeOne(x, now = NOW) {
  const sym = x.aset + 'USDT', t0 = Math.floor(x.t / H1) * H1;
  let nH1 = -1;
  const src = {
    now,
    h1: async () => { const k = (await bj(`klines?symbol=${sym}&interval=1h&startTime=${t0}&limit=1000`)).map(mapK); nH1 = k.length; return k; },
    m1: async (a, b) => (await bj(`klines?symbol=${sym}&interval=1m&startTime=${a}&endTime=${b}&limit=1000`)).map(mapK),
  };
  const g = await gradeTrade({ arah: x.arah, entry: x.entry, sl: x.sl, tp: x.tp, t: x.t, due: x.due }, src);
  if (nH1 === 0 && now - x.t > 2 * H1) return { final: true, status: 'TIDAK_VALID', R: 0, t: x.t, catatan: 'tanpa_candle_binance' };
  if (!g) return { final: false, status: 'OPEN', R: null, t: null };
  const status = { TP: 'TP', SL: 'SL', kedaluwarsa: 'KEDALUWARSA_TERISI', 'tidak terisi': 'TIDAK_TERISI', 'tidak valid': 'TIDAK_VALID' }[g.hasil];
  return { final: true, status, R: +g.R.toFixed(4), t: g.t };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function main() {
  const cacheFile = path.join(ROOT, 'data/grade-cache.json');
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const rows = [], counts = {};
  for (const m of cfg.mesin) {
    const f = path.join(RAW, m.id, 'journal.json');
    counts[m.id] = { baris_mesin: 0, duplikat_dibuang: 0, baris_monitor: 0 };
    if (m.aktif === false || !fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, 'utf8')), seen = new Set();
    counts[m.id].baris_mesin = j.length;
    for (const r of j) {
      const x = normalize(m, r), key = `${x.aset}|${x.arah}|${x.t}`;
      if (seen.has(key)) { counts[m.id].duplikat_dibuang++; continue; }
      seen.add(key); rows.push(x); counts[m.id].baris_monitor++;
    }
  }
  // tandai baris kembar antar fork (bukan bukti independen)
  const byKey = new Map();
  for (const x of rows) if (cfg.fork_group.includes(x.mesin)) { const k = `${x.aset}|${x.arah}|${x.t}`; (byKey.get(k) || byKey.set(k, []).get(k)).push(x.mesin); }
  for (const x of rows) { const g = byKey.get(`${x.aset}|${x.arah}|${x.t}`); x.fork_bersama = g && g.length > 1 && cfg.fork_group.includes(x.mesin) ? g : null; }

  // validasi + antrean penilaian (satu penilaian per tanda tangan unik)
  const todo = new Map();
  for (const x of rows) {
    const bad = invalidReason(x);
    if (x.status_mesin === 'NO_TRADE') { x.status_monitor = 'NO_TRADE'; x.R_monitor = 0; x.t_exit = null; continue; }
    if (bad) { x.status_monitor = 'TIDAK_VALID'; x.R_monitor = 0; x.t_exit = null; x.catatan = bad; continue; }
    x.sig = sigOf(x);
    if (cache[x.sig]) continue;
    if (!todo.has(x.sig)) todo.set(x.sig, x);
  }
  console.log(`baris ${rows.length}; perlu dinilai ${todo.size}; cache ${Object.keys(cache).length}`);
  const res = new Map(); let errs = 0;
  await pool([...todo.values()], 6, async x => {
    try { res.set(x.sig, await gradeOne(x)); }
    catch (e) { errs++; res.set(x.sig, { final: false, status: 'OPEN', R: null, t: null, error: e.invalid ? 'simbol_tidak_ada' : String(e.message).slice(0, 100), invalid: !!e.invalid }); }
  });
  for (const [s, g] of res) if (g.final) cache[s] = { status: g.status, R: g.R, t: g.t, catatan: g.catatan || null };
  else if (g.invalid) cache[s] = { status: 'TIDAK_VALID', R: 0, t: null, catatan: 'simbol_tidak_ada' };

  for (const x of rows) {
    if (x.status_monitor) continue;
    const g = cache[x.sig] || res.get(x.sig);
    if (g && g.status !== 'OPEN') { x.status_monitor = g.status; x.R_monitor = g.R; x.t_exit = g.t ?? null; if (g.catatan) x.catatan = g.catatan; }
    else { x.status_monitor = 'OPEN'; x.R_monitor = null; x.t_exit = null; if (g?.error) x.grade_error = g.error; }
    x.risk_pct = +(Math.abs(x.entry - x.sl) / x.entry * 100).toFixed(4);
    delete x.sig;
  }
  for (const x of rows) { if (!('risk_pct' in x) && Number.isFinite(x.entry) && Number.isFinite(x.sl) && x.entry) x.risk_pct = +(Math.abs(x.entry - x.sl) / x.entry * 100).toFixed(4); }
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const out = { generatedAt: new Date().toISOString(), now_ms: NOW, aturan: 'trade-sim.mjs dasar (tn/tnv2/chatgpt/crypto)', counts, grade_errors: errs, rows };
  fs.writeFileSync(path.join(ROOT, 'data/signals.json'), JSON.stringify(out));
  const dist = {}; for (const x of rows) dist[x.status_monitor] = (dist[x.status_monitor] || 0) + 1;
  console.log('selesai', JSON.stringify(dist), 'error', errs);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
