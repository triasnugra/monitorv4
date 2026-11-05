// Menarik journal.json + metadata tiap mesin ke data/raw/<mesin>/.
// - Gagal fetch / JSON rusak / kosong  -> data lama DIPERTAHANKAN, mesin ditandai basi.
// - Isi berubah -> versi lama disalin ke data/snapshots/<mesin>/ (satu per hari UTC, atau segera bila baris berkurang).
// Uji lokal: SOURCE_DIR=<folder berisi <mesin>/data/journal.json> node scripts/fetch.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const RAW = path.join(ROOT, 'data/raw'), SNAP = path.join(ROOT, 'data/snapshots');
const SRC = process.env.SOURCE_DIR || null;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 13) + 'Z'; // 20261105T0950Z

async function get(id, file) {
  if (SRC) {
    const p = path.join(SRC, id, 'data', file);
    if (!fs.existsSync(p)) return { status: 404 };
    return { status: 200, text: fs.readFileSync(p, 'utf8') };
  }
  const url = `${cfg.base}/${id}/data/${file}`;
  let last = null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${url}?cb=${Date.now()}`, { signal: AbortSignal.timeout(30000), headers: { 'cache-control': 'no-cache' } });
      if (r.status === 404) return { status: 404 };
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return { status: 200, text: await r.text() };
    } catch (e) { last = e; await new Promise(res => setTimeout(res, 1500 * (i + 1))); }
  }
  return { status: 0, error: String(last?.message || last) };
}

const statusFile = path.join(RAW, 'status.json');
const prevStatus = fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : { mesin: {} };
const out = { generatedAt: now.toISOString(), mesin: {} };

for (const m of cfg.mesin) {
  const st = { ...(prevStatus.mesin?.[m.id] || {}), lastAttemptAt: now.toISOString() };
  out.mesin[m.id] = st;
  if (m.aktif === false) { st.aktif = false; st.ok = false; st.error = 'tidak tersedia (lihat halaman Aturan)'; continue; }
  st.aktif = true;
  const dir = path.join(RAW, m.id); fs.mkdirSync(dir, { recursive: true });
  const jf = path.join(dir, 'journal.json');
  const r = await get(m.id, 'journal.json');
  let rows = null, err = null;
  if (r.status === 200) {
    try { const j = JSON.parse(r.text); if (!Array.isArray(j)) err = 'journal.json bukan array'; else if (!j.length) err = 'journal.json kosong'; else rows = j; }
    catch (e) { err = 'JSON rusak: ' + e.message; }
  } else err = r.status === 404 ? 'HTTP 404' : (r.error || 'gagal');
  if (err) { st.ok = false; st.error = err; console.log(`[${m.id}] GAGAL (${err}); data lama dipertahankan`); }
  else {
    const h = sha(r.text), old = fs.existsSync(jf) ? fs.readFileSync(jf, 'utf8') : null;
    if (old !== null && sha(old) !== h) {
      let oldRows = 0; try { oldRows = JSON.parse(old).length; } catch { /* abaikan */ }
      const shrink = rows.length < oldRows;
      const sd = path.join(SNAP, m.id); fs.mkdirSync(sd, { recursive: true });
      const day = now.toISOString().slice(0, 10);
      const haveToday = fs.readdirSync(sd).some(f => f.startsWith(day.replace(/-/g, '')));
      if (shrink || !haveToday) {
        fs.writeFileSync(path.join(sd, `${stamp}${shrink ? '-shrink' : ''}.json.gz`), zlib.gzipSync(old));
        console.log(`[${m.id}] snapshot versi lama${shrink ? ' (BARIS BERKURANG ' + oldRows + ' -> ' + rows.length + ')' : ''}`);
      }
      st.shrink = shrink ? { dari: oldRows, ke: rows.length, at: now.toISOString() } : st.shrink || null;
    }
    if (old === null || sha(old) !== h) { fs.writeFileSync(jf, r.text); st.changedAt = now.toISOString(); }
    if (st.shrink && rows.length >= st.shrink.dari) st.shrink = null;
    st.ok = true; st.error = null; st.fetchedAt = now.toISOString(); st.rows = rows.length; st.sha = h.slice(0, 16);
    console.log(`[${m.id}] OK ${rows.length} baris`);
  }
  for (const f of m.meta || []) {
    const x = await get(m.id, f);
    if (x.status === 200) { try { JSON.parse(x.text); fs.writeFileSync(path.join(dir, f), x.text); } catch { /* lewati file rusak */ } }
  }
}
fs.mkdirSync(RAW, { recursive: true });
fs.writeFileSync(statusFile, JSON.stringify(out, null, 1));
