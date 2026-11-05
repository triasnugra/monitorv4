// Verifikasi hash-chain di klien. Rumus disalin dari repo sumber (bukan dikarang):
//  - tn/tnv2/tnv2c2/dseek/chatgpt: forward-lib.mjs (SEAL; SEAL2 untuk baris sv===2 di tnv2c2), sha256 -> 20 hex
//  - crypto: scripts/journal-lib.mjs (IMMUTABLE), sha256 atas JSON objek -> 20 hex
const hex = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const SEAL = ['id', 't', 'due', 'agen', 'aset', 'arah', 'entry', 'sl', 'tp', 'harga_awal', 'alasan', 'alert', 'engine'];
const SEAL2 = [...SEAL, 'trig', 'score', 'grade', 'age'];
const IMMUTABLE = ['aset', 'arah', 't', 'tf', 'kind', 'harga_awal', 'mode', 'entry', 'sl', 'tp', 'tps', 'engine', 'seq', 'prev'];

const canon = r => JSON.stringify((r.sv === 2 ? SEAL2 : SEAL).map(k => (r[k] === undefined ? null : r[k])));
const link = async (prev, seq, r) => (await hex(`${prev}|${seq}|${canon(r)}`)).slice(0, 20);

export async function verifySeal(rows) {
  const f = rows.filter(r => r.fwd).sort((a, b) => a.seq - b.seq), errors = []; let prev = 'GENESIS';
  for (let i = 0; i < f.length; i++) {
    const r = f[i];
    if (r.seq !== i + 1) errors.push({ id: r.id, msg: `seq ${r.seq} tidak berurutan (harapan ${i + 1})` });
    if (r.prev !== prev) errors.push({ id: r.id, msg: 'tautan ke baris sebelumnya putus' });
    if (r.h !== await link(r.prev, r.seq, r)) errors.push({ id: r.id, msg: 'isi sinyal berubah setelah dicatat' });
    if (i && r.t < f[i - 1].t) errors.push({ id: r.id, msg: 'waktu lebih awal dari baris sebelumnya' });
    prev = r.h;
  }
  return { ok: !errors.length, n: f.length, tidak_tersegel: rows.length - f.length, head: f.length ? f.at(-1).h : null, errors };
}

export async function verifyCrypto(rows) {
  const errors = [], ids = new Set(); let prev = null;
  for (let i = 0; i < rows.length; i++) {
    const e = rows[i], o = {};
    for (const k of IMMUTABLE) o[k] = e[k] === undefined ? null : e[k];
    if (e.seq !== i + 1) errors.push({ id: e.id, msg: `seq ${e.seq}, seharusnya ${i + 1}` });
    if ((e.prev ?? null) !== prev) errors.push({ id: e.id, msg: 'prev tidak cocok dengan hash entri sebelumnya' });
    if (e.h !== (await hex(JSON.stringify(o))).slice(0, 20)) errors.push({ id: e.id, msg: 'isi entri berubah (hash tidak cocok)' });
    if (ids.has(e.id)) errors.push({ id: e.id, msg: 'id ganda' });
    ids.add(e.id); prev = e.h;
  }
  return { ok: !errors.length, n: rows.length, tidak_tersegel: 0, head: rows.length ? rows.at(-1).h : null, errors };
}

export const verify = (chainType, rows) => chainType === 'crypto' ? verifyCrypto(rows) : chainType === 'seal' ? verifySeal(rows) : Promise.resolve({ ok: null, n: 0, tidak_tersegel: rows.length, head: null, errors: [], catatan: 'mesin ini tidak punya hash-chain' });
