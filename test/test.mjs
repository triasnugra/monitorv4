// Tes logika murni: penilaian, statistik, hash-chain. Tanpa jaringan. Jalankan: node test/test.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { gradeTrade, H1 } from '../scripts/trade-sim.mjs';
import { invalidReason, normalize } from '../scripts/grade.mjs';
import { wilson, bootCI, summarize, basisProtokol, konsensus, netR, costPct } from '../assets/stats.js';
import { verifySeal, verifyCrypto } from '../assets/chain.js';

let n = 0; const ok = (name, fn) => Promise.resolve(fn()).then(() => { n++; console.log('ok -', name); });
const T0 = Date.UTC(2026, 10, 1, 10, 30), HR = H1;
const bar = (ot, o, h, l, c) => ({ ot, o, h, l, c, ct: ot + HR - 1 });
const grade = (r, cs, m1 = null, now = T0 + 20 * 864e5) => gradeTrade({ due: T0 + 7 * 864e5, t: T0, ...r }, { h1: async () => cs, m1, now });
const base = { arah: 'LONG', entry: 100, sl: 95, tp: 110 };
const h0 = Math.floor(T0 / HR) * HR;

await ok('TP: terisi lalu TP, R = RR rencana', async () => {
  const g = await grade(base, [bar(h0, 101, 102, 100.5, 101), bar(h0 + HR, 101, 101, 99, 100), bar(h0 + 2 * HR, 100, 111, 100, 110)]);
  assert.equal(g.hasil, 'TP'); assert.equal(g.R, 2);
});
await ok('SL didahulukan bila SL dan TP di candle yang sama tanpa 1m', async () => {
  const g = await grade(base, [bar(h0, 101, 102, 100.5, 101), bar(h0 + HR, 100, 111, 94, 100)]);
  assert.equal(g.hasil, 'SL'); assert.equal(g.R, -1);
});
await ok('candle pengisi yang menyentuh SL dihitung SL', async () => {
  const g = await grade(base, [bar(h0, 101, 102, 101, 101), bar(h0 + HR, 102, 103, 94, 96)]);
  assert.equal(g.hasil, 'SL');
});
await ok('tidak terisi bila entry tak pernah tersentuh (R=0)', async () => {
  const g = await grade(base, [bar(h0, 105, 106, 104, 105), bar(h0 + HR, 105, 107, 103, 106)]);
  assert.equal(g.hasil, 'tidak terisi'); assert.equal(g.R, 0);
});
await ok('kedaluwarsa terisi dinilai di close candle terakhir, bukan TP', async () => {
  const cs = [bar(h0, 101, 102, 101, 101), bar(h0 + HR, 100, 101, 99, 99)];
  for (let i = 2; i < 200; i++) cs.push(bar(h0 + i * HR, 99, 100, 98, 99));
  const g = await grade(base, cs);
  assert.equal(g.hasil, 'kedaluwarsa'); assert.ok(Math.abs(g.R - (99 - 100) / 5) < 1e-9);
});
await ok('belum selesai -> null (OPEN)', async () => {
  const g = await grade(base, [bar(h0, 101, 102, 101, 101), bar(h0 + HR, 101, 102, 100.5, 101)], null, T0 + 5 * HR);
  assert.equal(g, null);
});
await ok('candle saat sinyal hanya lewat 1m setelah waktu sinyal', async () => {
  // 1m sebelum sinyal menyentuh SL (harus diabaikan); setelah sinyal menyentuh entry lalu TP
  const m1 = async () => [{ ot: T0 - 60000, o: 100, h: 100, l: 90, c: 90 }, { ot: T0 + 60000, o: 101, h: 101, l: 100, c: 100 }, { ot: T0 + 120000, o: 100, h: 111, l: 100, c: 110 }];
  const g = await grade(base, [bar(h0, 101, 111, 90, 100)], m1);
  assert.equal(g.hasil, 'TP');
});
await ok('SHORT simetris', async () => {
  const g = await grade({ arah: 'SHORT', entry: 100, sl: 105, tp: 90 }, [bar(h0, 99, 99, 98, 99), bar(h0 + HR, 99, 100.5, 98, 99), bar(h0 + 2 * HR, 99, 101, 89, 90)]);
  assert.equal(g.hasil, 'TP'); assert.equal(g.R, 2);
});
await ok('invalidReason', () => {
  assert.equal(invalidReason({ aset: '', arah: 'LONG', entry: 1, sl: .9, tp: 1.2, t: 1, due: 2 }), 'simbol_kosong');
  assert.equal(invalidReason({ aset: 'X', arah: 'LONG', entry: 1, sl: 1.1, tp: 1.2, t: 1, due: 2 }), 'urutan_entry_sl_tp_salah');
  assert.equal(invalidReason({ aset: 'X', arah: 'SHORT', entry: 1, sl: 1.1, tp: .8, t: 1, due: 2 }), null);
});
await ok('normalize: status mesin dipetakan, crypto tanpa status', () => {
  const x = normalize({ id: 'tn', chain: 'seal' }, { id: 'a', aset: 'BTC', arah: 'LONG', entry: 1, sl: .9, tp: 1.2, t: 1, due: 2, hasil: 'kedaluwarsa', R: 0.61, fwd: 1 });
  assert.equal(x.status_mesin, 'KEDALUWARSA_TERISI'); assert.equal(x.sealed, true);
  const c = normalize({ id: 'crypto', chain: 'crypto', tanpa_hasil: true }, { id: 'c', aset: 'ETH', arah: 'SHORT', entry: 1, sl: 1.1, tp: .8, t: 1, due: 2, h: 'x', kind: 'mon', tps: [] });
  assert.equal(c.status_mesin, null); assert.equal(c.kind, 'mon');
});

const B = { fee_persen_per_sisi: .05, slip_persen: .05 };
const mk = (status, R, extra = {}) => ({ mesin: 'x', aset: 'A', arah: 'LONG', t: T0, due: T0 + 1, entry: 100, sl: 95, tp: 110, risk_pct: 5, status_monitor: status, R_monitor: R, t_exit: T0 + 1000, sealed: true, ...extra });
await ok('biaya: R net = R - 0,15% / risiko%', () => { assert.ok(Math.abs(costPct(B) - .15) < 1e-12); assert.ok(Math.abs(netR(mk('TP', 2), B) - (2 - .15 / 5)) < 1e-12); assert.equal(netR(mk('TIDAK_TERISI', 0), B), 0); });
await ok('wilson', () => { const w = wilson(5, 10); assert.ok(Math.abs(w.lo - .2366) < .002 && Math.abs(w.hi - .7634) < .002); assert.equal(wilson(0, 0), null); });
await ok('summarize: TP/KED terpisah, win-rate hanya dari terisi', () => {
  const rows = [mk('TP', 2), mk('TP', 2), mk('SL', -1), mk('KEDALUWARSA_TERISI', .5), mk('KEDALUWARSA_TERISI', -.4), mk('TIDAK_TERISI', 0), mk('OPEN', null), mk('NO_TRADE', 0), mk('TIDAK_VALID', 0)];
  const s = summarize(rows, B);
  assert.equal(s.n_sinyal, 7); assert.equal(s.n_terisi, 5); assert.equal(s.n_tp, 2); assert.equal(s.n_ked, 2);
  assert.equal(s.win_a, 2 / 3); assert.equal(s.win_b, 3 / 5); assert.equal(s.fill_rate, 5 / 6); assert.equal(s.kecil, true);
});
await ok('bootCI deterministik dan menutup rata-rata', () => {
  const it = []; for (let w = 0; w < 8; w++) for (let k = 0; k < 4; k++) it.push({ t: Date.UTC(2026, 9, 5 + 7 * w), R: w % 2 ? 1 : -0.5 });
  const a = bootCI(it), b = bootCI(it); assert.deepEqual(a, b); assert.equal(a.clusters, 8); assert.ok(a.lo < .25 && a.hi > .25);
  assert.equal(bootCI(it.slice(0, 4)).lo, null);
});
await ok('basisProtokol: satu order aktif per koin, abaikan engine lain & sebelum mulai', () => {
  const P = { agen: 'A', engine: 'E', mulai_ms: T0, aturan: { satu_order_aktif_per_koin: true } };
  const r = (t, st, ex = {}) => mk(st, 1, { agen: 'A', engine: 'E', t, t_exit: t + 3600e3, ...ex });
  const rows = [r(T0, 'TP'), r(T0 + 1800e3, 'TP'), r(T0 + 7200e3, 'SL'), r(T0 + 14.4e6, 'OPEN'), r(T0 + 14.5e6, 'TP'), r(T0 - 1, 'TP'), r(T0 + 5, 'TP', { engine: 'Z' }), r(T0 + 6, 'TP', { sealed: false })];
  const k = basisProtokol(rows, P);
  assert.equal(k.kept.length, 3); assert.equal(k.skipped, 2);
});
await ok('konsensus: baris kembar fork = satu sumber', () => {
  const f = (m, t = T0, ex = {}) => mk('TP', 2, { mesin: m, aset: 'ETH', t, fork_bersama: ['tn', 'tnv2'], ...ex });
  const ev = konsensus([f('tn'), f('tnv2'), mk('SL', -1, { mesin: 'crypto', aset: 'ETH', t: T0 + 3600e3 }), mk('TP', 2, { mesin: 'dseek', aset: 'ETH', t: T0 + 40 * 3600e3 })], 24 * 3600e3);
  assert.equal(ev.length, 2); assert.equal(ev[0].level, 2); assert.deepEqual(ev[0].sumber.sort(), ['crypto', 'fork-bersama']); assert.equal(ev[1].level, 1);
});

// hash-chain: bangun rantai dengan rumus forward-lib lalu uji deteksi perubahan
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SEAL = ['id', 't', 'due', 'agen', 'aset', 'arah', 'entry', 'sl', 'tp', 'harga_awal', 'alasan', 'alert', 'engine'];
const seal = (rows) => { let prev = null; return rows.map((r, i) => { const row = { ...r, fwd: 1, seq: i + 1, prev: prev ? prev.h : 'GENESIS' }; row.h = sha(`${row.prev}|${row.seq}|${JSON.stringify(SEAL.map(k => row[k] === undefined ? null : row[k]))}`).slice(0, 20); prev = row; return row; }); };
const base3 = [1, 2, 3].map(i => ({ id: 'r' + i, t: T0 + i, due: T0 + i + 9, agen: 'A', aset: 'BTC', arah: 'LONG', entry: 100 + i, sl: 90, tp: 120, harga_awal: 100, alasan: 'x', alert: '', engine: 'E' }));
await ok('verifySeal: utuh, lalu terdeteksi bila isi diubah / baris dihapus', async () => {
  const c = seal(base3); assert.equal((await verifySeal(c)).ok, true);
  const t1 = structuredClone(c); t1[1].entry = 999; assert.equal((await verifySeal(t1)).ok, false);
  assert.equal((await verifySeal([c[0], c[2]])).ok, false);
});
await ok('verifyCrypto: skema IMMUTABLE', async () => {
  const IMM = ['aset', 'arah', 't', 'tf', 'kind', 'harga_awal', 'mode', 'entry', 'sl', 'tp', 'tps', 'engine', 'seq', 'prev'];
  let prev = null; const rows = [1, 2].map(i => { const e = { id: 'c' + i, aset: 'ETH', arah: 'LONG', t: T0 + i, tf: '4H', kind: 'mon', harga_awal: 1, mode: 'limit', entry: 1, sl: .9, tp: 1.2, tps: [{ v: 1.2, l: 'TP1' }], engine: 'E', seq: i, prev }; const o = {}; for (const k of IMM) o[k] = e[k] ?? null; e.h = sha(JSON.stringify(o)).slice(0, 20); prev = e.h; return e; });
  assert.equal((await verifyCrypto(rows)).ok, true);
  rows[1].entry = 2; assert.equal((await verifyCrypto(rows)).ok, false);
});
console.log(`\n${n} tes lulus`);
