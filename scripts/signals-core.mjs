// signals-core.mjs : SATU-SATUNYA tempat mendefinisikan "analisis milik mesin X" (koin, arah, waktu).
// Dipakai identik oleh monitortn, monitorv2, monitorv3, monitorv4 agar coin & tanggalnya sama.
// Tidak mengubah mesin. Tidak menilai hasil (TP/SL): penilaian tetap urusan tiap monitor.
//
// Aturan (semua terbukti dari data jurnal 2026-11-11):
//  1. Waktu analisis = field `t` (epoch ms, UTC). String `waktu` hanya label; bila beda dari `t`, `t` menang.
//  2. tanggal_utc dan tanggal_wib (UTC+7) selalu diturunkan dari `t`. Monitor boleh menampilkan salah satu.
//  3. tnv2, tnv2c2, chatgpt mewarisi rantai jurnal tn (engine v1). Baris berhash v1 pada mesin itu = 'warisan',
//     BUKAN analisis milik mesin tersebut. Mesin tn sendiri memiliki hash v1.
//  4. Baris tanpa field engine (15 baris 2026-10-04) = 'legacy': milik tn, warisan di mesin lain.
//  5. Milik sendiri = hash engine terbaru yang BUKAN hash v1 (otomatis, tanpa hardcode hash).
//  6. Dua agen mencatat analisis identik dalam <= 60 detik (tnv2: "Aturan Eliz" dan "Eliz v2") = satu analisis.
//  7. Bila forward-protocol menunjuk engine yang berbeda dari engine milik sendiri (kasus chatgpt),
//     dihasilkan peringatan PROTOKOL_TIDAK_SINKRON. Data tidak diubah diam-diam.

export const HARI = 864e5, WIB_MS = 7 * 36e5;
const pad = n => String(n).padStart(2, '0');
const iso = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
const hm = ms => { const d = new Date(ms); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
export const tanggalUtc = ms => iso(ms);
export const tanggalWib = ms => iso(ms + WIB_MS);
export const waktuUtc = ms => `${iso(ms)} ${hm(ms)}`;
export const waktuWib = ms => `${iso(ms + WIB_MS)} ${hm(ms + WIB_MS)}`;

const num = x => (x === null || x === undefined || x === '' ? NaN : +x);

// Satu baris jurnal mentah -> bentuk kanonik (nama field sama untuk semua monitor).
export function normalizeRow(mesin, r) {
  const t = num(r.t);
  const row = {
    id: `${mesin}|${r.id ?? ''}`, mesin,
    aset: String(r.aset ?? r.symbol ?? '').toUpperCase() || null,
    arah: r.arah ?? r.side ?? null,
    entry: num(r.entry), sl: num(r.sl), tp: num(r.tp), t, due: num(r.due),
    engine: r.engine ?? null, agen: r.agen ?? null, fwd: r.fwd ? 1 : 0, seq: r.seq ?? null,
    hasil_mesin: r.hasil ?? null, R_mesin: r.R === '' || r.R == null ? null : +r.R,
  };
  if (Number.isFinite(t)) {
    row.waktu_utc = waktuUtc(t); row.tanggal_utc = tanggalUtc(t);
    row.waktu_wib = waktuWib(t); row.tanggal_wib = tanggalWib(t);
    row.waktu_label_cocok = !r.waktu || String(r.waktu).slice(0, 16) === row.waktu_utc;
  } else { row.waktu_label_cocok = false; row.salah = 'waktu_tidak_valid'; }
  if (r.kind !== undefined) row.kind = r.kind;
  if (r.tf !== undefined) row.tf = r.tf;
  return row;
}

// Hash engine yang dimiliki rantai tn (sumber v1). Diambil dari jurnal tn, bukan di-hardcode.
export function hashV1(rowsTn) {
  const c = new Map();
  for (const r of rowsTn) if (r.engine) c.set(r.engine, (c.get(r.engine) || 0) + 1);
  return new Set([...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 1).map(x => x[0]));
}

// Engine milik sendiri sebuah mesin: hash non-v1 dengan analisis pertama paling baru. tn: hash v1 itu sendiri.
export function engineSendiri(mesin, rows, v1) {
  if (mesin === 'tn') return [...v1][0] ?? null;
  const first = new Map();
  for (const r of rows) if (r.engine && !v1.has(r.engine) && Number.isFinite(r.t)) first.set(r.engine, Math.min(first.get(r.engine) ?? Infinity, r.t));
  return [...first.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

export function protokolAktif(files) {
  return (files || []).filter(p => p && p.mulai_ms && p.engine).sort((a, b) => b.mulai_ms - a.mulai_ms)[0] ?? null;
}

// Buang analisis kembar dalam satu mesin. Yang dipertahankan: milik sendiri, bila tidak ada baris paling awal.
export function dedupe(rows, sendiriEngine, windowMs = 60000) {
  const sorted = [...rows].sort((a, b) => a.t - b.t), kept = [], last = new Map(), exact = new Set();
  let dibuang = 0;
  const skor = r => (r.engine === sendiriEngine ? 1 : 0);
  for (const x of sorted) {
    const ek = `${x.aset}|${x.arah}|${x.t}`;
    if (exact.has(ek)) { dibuang++; continue; }
    exact.add(ek);
    const k = [x.aset, x.arah, x.entry, x.sl, x.tp].join('|'), i = last.get(k);
    if (i !== undefined && Number.isFinite(x.t) && x.t - kept[i].t <= windowMs) {
      dibuang++; if (skor(x) > skor(kept[i])) kept[i] = x; continue;
    }
    last.set(k, kept.push(x) - 1);
  }
  return { rows: kept, dibuang };
}

// journals: { mesin: [baris mentah] }, protocols: { mesin: [isi forward-protocol*.json] }
export function buildCanonical(journals, protocols = {}) {
  const v1 = hashV1(journals.tn || []);
  const out = [], laporan = {}, peringatan = [];
  for (const [mesin, mentah] of Object.entries(journals)) {
    const norm = mentah.map(r => normalizeRow(mesin, r));
    const own = engineSendiri(mesin, norm, v1);
    const dd = dedupe(norm.filter(r => !r.salah), own);
    const L = laporan[mesin] = { baris_mesin: mentah.length, twin_dibuang: dd.dibuang, sendiri: 0, warisan_v1: 0, legacy: 0, tidak_valid: norm.filter(r => r.salah).length,
      engine_sendiri: own, engine_protokol: null, protokol_sinkron: null, waktu_label_beda: 0 };
    for (const r of dd.rows) {
      if (!r.waktu_label_cocok) L.waktu_label_beda++;
      if (!r.engine) { r.milik = mesin === 'tn' ? 'sendiri' : 'warisan_v1'; r.legacy = true; r.milik === 'sendiri' ? L.legacy++ : L.warisan_v1++; }
      else if (r.engine === own) { r.milik = 'sendiri'; L.sendiri++; }
      else if (v1.has(r.engine)) { r.milik = mesin === 'tn' ? 'sendiri' : 'warisan_v1'; r.milik === 'sendiri' ? L.sendiri++ : L.warisan_v1++; }
      else { r.milik = 'engine_lain'; }
      out.push(r);
    }
    const P = protokolAktif(protocols[mesin]);
    if (P) {
      L.engine_protokol = P.engine; L.protokol_sinkron = own ? P.engine === own : null;
      if (own && P.engine !== own) peringatan.push({ kode: 'PROTOKOL_TIDAK_SINKRON', mesin, t: `forward-protocol menunjuk engine ${P.engine} tetapi analisis milik ${mesin} berhash ${own}. Laporan mesin menghitung baris warisan, bukan baris sendiri.` });
    }
    const s = out.filter(r => r.mesin === mesin && r.milik === 'sendiri');
    if (s.length) { L.pertama_utc = s[0].waktu_utc; L.terakhir_utc = s.at(-1).waktu_utc; }
  }
  out.sort((a, b) => a.t - b.t || a.mesin.localeCompare(b.mesin));
  return { dibuat: new Date().toISOString(), aturan: 'signals-core.v1', hash_v1: [...v1], laporan, peringatan, rows: out };
}

// ---- CLI: node signals-core.mjs <folder-raw>   (layout v4: <folder>/<mesin>/journal.json + forward-protocol*.json)
//      atau SOURCE_BASE=https://triasnugra.github.io node signals-core.mjs --url
import fs from 'node:fs';
import path from 'node:path';
const MESIN = ['tn', 'tnv2', 'tnv2c2', 'dseek', 'chatgpt', 'crypto', 'grox'];
async function muatDir(dir) {
  const J = {}, P = {};
  for (const m of MESIN) {
    const d = path.join(dir, m), f = path.join(d, 'journal.json');
    if (!fs.existsSync(f)) continue;
    J[m] = JSON.parse(fs.readFileSync(f, 'utf8'));
    P[m] = fs.readdirSync(d).filter(x => /^forward-protocol.*\.json$/.test(x)).map(x => JSON.parse(fs.readFileSync(path.join(d, x), 'utf8')));
  }
  return { J, P };
}
async function muatUrl(base) {
  const J = {}, P = {}, get = async u => { const r = await fetch(`${u}?cb=${Date.now()}`, { signal: AbortSignal.timeout(30000) }); return r.ok ? r.json() : null; };
  for (const m of MESIN) {
    const j = await get(`${base}/${m}/data/journal.json`); if (!Array.isArray(j) || !j.length) continue;
    J[m] = j; P[m] = [];
    for (const f of ['forward-protocol.json', 'forward-protocol-v2.json']) { const p = await get(`${base}/${m}/data/${f}`).catch(() => null); if (p) P[m].push(p); }
  }
  return { J, P };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv[2];
  const { J, P } = a === '--url' ? await muatUrl(process.env.SOURCE_BASE || 'https://triasnugra.github.io') : await muatDir(a || 'data/raw');
  const c = buildCanonical(J, P);
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/signals-canonical.json', JSON.stringify(c));
  console.table(c.laporan);
  for (const w of c.peringatan) console.log(`[${w.kode}] ${w.mesin}: ${w.t}`);
  console.log('tulis data/signals-canonical.json,', c.rows.length, 'baris');
}
