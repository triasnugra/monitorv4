// Fungsi murni untuk metrik. Dipakai browser (app.js) dan tes node (test/test.mjs).
export const FILLED = s => s === 'TP' || s === 'SL' || s === 'KEDALUWARSA_TERISI';
export const RESOLVED = s => FILLED(s) || s === 'TIDAK_TERISI';
export const COUNTED = s => s !== 'NO_TRADE' && s !== 'TIDAK_VALID'; // "sinyal" = bukan NO_TRADE / tidak valid

export const costPct = b => 2 * b.fee_persen_per_sisi + b.slip_persen;
// R sesudah biaya untuk trade terisi: biaya (% harga) dibagi risiko (% harga). Sama dengan forward-lib.mjs.
export const netR = (r, b) => (FILLED(r.status_monitor) && r.risk_pct > 0 ? r.R_monitor - costPct(b) / r.risk_pct : 0);
export const exitT = r => r.t_exit ?? r.due;

export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const weekKey = t => Math.floor((t - 4 * 864e5) / (7 * 864e5)); // minggu Senin UTC, sama dengan protokol mesin

export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return { lo: (c - m) / d, hi: (c + m) / d };
}

// Bootstrap cluster per minggu (sinyal). items: [{t, R}] hanya trade terisi.
export function bootCI(items, { B = 5000, seed = 1, alpha = 0.05 } = {}) {
  const m = new Map();
  for (const r of items) { const k = weekKey(r.t), o = m.get(k) || { s: 0, n: 0 }; o.s += r.R; o.n++; m.set(k, o); }
  const cl = [...m.values()], C = cl.length;
  if (C < 2) return { lo: null, hi: null, clusters: C };
  const rnd = mulberry32(seed), means = new Float64Array(B);
  for (let b = 0; b < B; b++) { let S = 0, N = 0; for (let i = 0; i < C; i++) { const p = cl[(rnd() * C) | 0]; S += p.s; N += p.n; } means[b] = N ? S / N : 0; }
  means.sort();
  return { lo: means[Math.floor(alpha / 2 * B)], hi: means[Math.min(B - 1, Math.floor((1 - alpha / 2) * B))], clusters: C };
}

export function summarize(rows, biaya, { boot = true } = {}) {
  const sig = rows.filter(r => COUNTED(r.status_monitor));
  const f = sig.filter(r => FILLED(r.status_monitor));
  const tp = f.filter(r => r.status_monitor === 'TP').length, sl = f.filter(r => r.status_monitor === 'SL').length;
  const ked = f.filter(r => r.status_monitor === 'KEDALUWARSA_TERISI');
  const kedW = ked.filter(r => netR(r, biaya) > 0).length, kedL = ked.length - kedW;
  const nt = sig.filter(r => r.status_monitor === 'TIDAK_TERISI').length, open = sig.filter(r => r.status_monitor === 'OPEN').length;
  const g = f.map(r => r.R_monitor), n = f.map(r => netR(r, biaya)), nF = f.length;
  const sum = a => a.reduce((x, y) => x + y, 0);
  const gw = sum(n.filter(x => x > 0)), gl = -sum(n.filter(x => x < 0));
  let c = 0, pk = 0, dd = 0;
  for (const r of [...f].sort((a, b) => exitT(a) - exitT(b))) { c += netR(r, biaya); pk = Math.max(pk, c); dd = Math.max(dd, pk - c); }
  const selesai = nF + nt;
  const wa = tp + sl, wbW = tp + kedW, wbN = nF;
  return {
    n_sinyal: sig.length, n_open: open, n_selesai: selesai, n_terisi: nF, n_tidak_terisi: nt,
    n_tp: tp, n_sl: sl, n_ked: ked.length, n_ked_win: kedW, n_ked_loss: kedL,
    n_tidak_valid: rows.filter(r => r.status_monitor === 'TIDAK_VALID').length, n_no_trade: rows.filter(r => r.status_monitor === 'NO_TRADE').length,
    fill_rate: selesai ? nF / selesai : null,
    win_a: wa ? tp / wa : null, n_win_a: wa, ci_a: wilson(tp, wa),
    win_b: wbN ? wbW / wbN : null, n_win_b: wbN, ci_b: wilson(wbW, wbN),
    avg_R_gross: nF ? sum(g) / nF : null, avg_R_net: nF ? sum(n) / nF : null,
    total_R_net: sum(n), pf: gl > 0 ? gw / gl : nF && gw > 0 ? Infinity : null, max_dd: dd,
    ci_exp: boot && nF ? bootCI(f.map(r => ({ t: r.t, R: netR(r, biaya) }))) : null,
    minggu: new Set(f.map(r => weekKey(r.t))).size, kecil: nF < 30,
  };
}

// Basis protokol: meniru pickSignals() di forward-lib.mjs, tetapi hasil dinilai ulang monitor.
// Syarat: tersegel, agen & engine sesuai protokol, t >= mulai, bukan NO_TRADE/tidak valid, lalu
// satu order aktif per koin (order yang belum selesai memblokir sinyal berikutnya pada koin itu).
export function basisProtokol(rows, P) {
  const base = rows.filter(r => r.sealed && r.agen === P.agen && r.t >= P.mulai_ms && (r.arah === 'LONG' || r.arah === 'SHORT') && COUNTED(r.status_monitor));
  const same = base.filter(r => r.engine === P.engine).sort((a, b) => a.t - b.t);
  if (!P.aturan?.satu_order_aktif_per_koin) return { kept: same, skipped: 0, other: base.length - same.length };
  const busy = new Map(), kept = []; let skipped = 0;
  for (const r of same) {
    if (r.t < (busy.get(r.aset) ?? 0)) { skipped++; continue; }
    kept.push(r); busy.set(r.aset, RESOLVED(r.status_monitor) ? exitT(r) : Infinity);
  }
  return { kept, skipped, other: base.length - same.length };
}

// Protokol aktif sebuah mesin = file protokol dengan mulai_ms terbaru. null bila tidak ada.
export function pilihProtokol(files) {
  const ps = files.filter(Boolean).filter(p => p.mulai_ms && p.engine);
  return ps.sort((a, b) => b.mulai_ms - a.mulai_ms)[0] || null;
}

export function groupBy(rows, fn) { const m = new Map(); for (const r of rows) { const k = fn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; }

// Konsensus: aset+arah yang sama dari >=k SUMBER INDEPENDEN dalam jendela. Baris kembar antar fork = satu sumber.
export function collapseFork(rows) {
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (r.fork_bersama) { const k = `${r.aset}|${r.arah}|${r.t}`; if (seen.has(k)) continue; seen.add(k); out.push({ ...r, sumber: 'fork-bersama' }); }
    else out.push({ ...r, sumber: r.mesin });
  }
  return out;
}
export function konsensus(rows, jendelaMs) {
  const rs = collapseFork(rows.filter(r => r.arah && COUNTED(r.status_monitor)));
  const grp = groupBy(rs, r => r.aset + '|' + r.arah), events = [];
  for (const [key, list] of grp) {
    list.sort((a, b) => a.t - b.t);
    let i = 0;
    while (i < list.length) {
      const start = list[i].t, g = [];
      while (i < list.length && list[i].t - start <= jendelaMs) g.push(list[i++]);
      const bySrc = new Map();
      for (const r of g) if (!bySrc.has(r.sumber)) bySrc.set(r.sumber, r); // sinyal paling awal tiap sumber
      events.push({ key, t: start, level: bySrc.size, rows: [...bySrc.values()], sumber: [...bySrc.keys()] });
    }
  }
  return events;
}

export function toCSV(rows, cols) {
  const esc = v => { if (v === null || v === undefined) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}
