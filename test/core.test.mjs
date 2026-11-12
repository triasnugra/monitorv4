// node --test signals-core.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCanonical, normalizeRow, tanggalUtc, tanggalWib, dedupe } from '../scripts/signals-core.mjs';

const T0 = Date.UTC(2026, 10, 10, 20, 30); // 10 Nov 20:30 UTC = 11 Nov 03:30 WIB
const r = (o = {}) => ({ id: 'x', waktu: '2026-11-10 20:30 UTC', t: T0, due: T0 + 6048e5, aset: 'ETH', arah: 'SHORT', entry: 100, sl: 110, tp: 80, hasil: 'menunggu', R: '', ...o });

test('tanggal UTC dan WIB diturunkan dari t, bukan dari string', () => {
  assert.equal(tanggalUtc(T0), '2026-11-10');
  assert.equal(tanggalWib(T0), '2026-11-11');
  const n = normalizeRow('tn', r({ waktu: '2026-11-09 01:00 UTC' }));
  assert.equal(n.tanggal_utc, '2026-11-10');
  assert.equal(n.waktu_label_cocok, false);
});

test('baris berhash v1 di mesin turunan = warisan; milik sendiri = hash non-v1', () => {
  const tn = [r({ engine: 'V1' }), r({ engine: 'V1', aset: 'SOL', t: T0 + 1 })];
  const v2 = [r({ engine: 'V1', agen: 'Aturan Eliz' }), r({ engine: 'V2', agen: 'Eliz v2', aset: 'BTC', t: T0 + 5e5 })];
  const c = buildCanonical({ tn, tnv2: v2 });
  assert.equal(c.laporan.tn.sendiri, 2);
  assert.equal(c.laporan.tnv2.sendiri, 1);
  assert.equal(c.laporan.tnv2.warisan_v1, 1);
  assert.equal(c.laporan.tnv2.engine_sendiri, 'V2');
});

test('baris tanpa engine: legacy milik tn, warisan di mesin lain', () => {
  const c = buildCanonical({ tn: [r({ engine: 'V1' }), r({ aset: 'ADA', t: T0 - 9e8 })], chatgpt: [r({ aset: 'ADA', t: T0 - 9e8 }), r({ engine: 'G', aset: 'LTC', t: T0 + 9 })] });
  assert.equal(c.rows.find(x => x.mesin === 'tn' && x.aset === 'ADA').milik, 'sendiri');
  assert.equal(c.rows.find(x => x.mesin === 'chatgpt' && x.aset === 'ADA').milik, 'warisan_v1');
});

test('dua agen mencatat setup identik dalam 60 detik jadi satu, utamakan milik sendiri', () => {
  const a = r({ engine: 'V1', agen: 'Aturan Eliz', t: T0 }), b = r({ engine: 'V2', agen: 'Eliz v2', t: T0 + 40 });
  const d = dedupe([a, b].map(x => normalizeRow('tnv2', x)), 'V2');
  assert.equal(d.rows.length, 1); assert.equal(d.dibuang, 1); assert.equal(d.rows[0].engine, 'V2');
  const lewat = dedupe([a, { ...b, t: T0 + 61000 }].map(x => normalizeRow('tnv2', x)), 'V2');
  assert.equal(lewat.rows.length, 2);
});

test('protokol menunjuk engine lain dari milik sendiri -> PROTOKOL_TIDAK_SINKRON (data tidak diubah)', () => {
  const tn = [r({ engine: 'V1' })];
  const g = [r({ engine: 'V1', t: T0 + 1 }), r({ engine: 'G', t: T0 + 2, aset: 'LTC' })];
  const c = buildCanonical({ tn, chatgpt: g }, { chatgpt: [{ mulai_ms: 1, engine: 'V1', agen: 'Aturan Eliz' }] });
  assert.equal(c.peringatan[0].kode, 'PROTOKOL_TIDAK_SINKRON');
  assert.equal(c.laporan.chatgpt.sendiri, 1);
});

test('invarian: sendiri + warisan + engine_lain + twin = baris mesin', () => {
  const tn = [r({ engine: 'V1' }), r({ engine: 'V1', aset: 'SOL', t: T0 + 1 })];
  const v2 = [r({ engine: 'V1' }), r({ engine: 'V2', aset: 'BTC', t: T0 + 3 }), r({ engine: 'V2', aset: 'BTC', t: T0 + 4 })];
  const c = buildCanonical({ tn, tnv2: v2 });
  for (const [m, L] of Object.entries(c.laporan)) assert.equal(L.sendiri + L.warisan_v1 + L.twin_dibuang + L.tidak_valid, L.baris_mesin, m);
});
