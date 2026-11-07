import { FILLED, COUNTED, netR, exitT, summarize, basisProtokol, pilihProtokol, groupBy, konsensus, collapseFork, weekKey, toCSV, costPct } from './stats.js';
import { verify } from './chain.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = ['#56b4e9', '#e69f00', '#009e73', '#f0e442', '#cc79a7', '#d55e00', '#0072b2'];
const fmtP = x => (x == null ? '–' : (x * 100).toFixed(0) + '%');
const fmtR = (x, d = 2) => (x == null || !Number.isFinite(x) ? (x === Infinity ? '∞' : '–') : (x >= 0 ? '+' : '') + x.toFixed(d));
const cls = x => (x > 0 ? 'pos' : x < 0 ? 'neg' : '');
const fmtT = ms => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '–');
const ago = ms => { const h = (Date.now() - ms) / 36e5; return h < 1 ? Math.round(h * 60) + ' mnt' : h < 48 ? h.toFixed(1) + ' jam' : (h / 24).toFixed(1) + ' hari'; };
const jget = async u => { try { const r = await fetch(u + (u.includes('?') ? '&' : '?') + 'v=' + Date.now()); return r.ok ? await r.json() : null; } catch { return null; } };
const nTag = n => `<span class="n">n=${n}</span>`;
const small = n => (n < 30 ? ' <span class="badge warn">sampel kecil</span>' : '');
const ciTxt = (c, f = fmtP) => (c && c.lo != null ? `<span class="ci">CI95 [${f(c.lo)} .. ${f(c.hi)}]</span>` : '<span class="ci">CI n/a</span>');

const S = { cfg: null, sig: null, status: null, raw: {}, meta: {}, chain: {}, basis: 'protokol', biaya: null };

// ---------- muat data ----------
async function load() {
  S.cfg = await jget('config.json');
  S.biaya = S.cfg.biaya;
  S.sig = await jget('data/signals.json');
  S.status = (await jget('data/raw/status.json')) || { mesin: {} };
  document.querySelectorAll('[data-cfg]').forEach(el => {
    const k = el.dataset.cfg; el.textContent = k === 'fee' ? S.biaya.fee_persen_per_sisi : k === 'slip' ? S.biaya.slip_persen : costPct(S.biaya).toFixed(2);
  });
  if (!S.sig) return false;
  await Promise.all(S.cfg.mesin.map(async m => {
    if (m.aktif === false) return;
    const raw = await jget(`data/raw/${m.id}/journal.json`);
    if (raw) S.raw[m.id] = raw;
    const g = async f => jget(`data/raw/${m.id}/${f}`);
    S.meta[m.id] = {
      protos: (await Promise.all((m.meta || []).filter(f => /^forward-protocol/.test(f)).map(async f => { const p = await g(f); return p ? { ...p, _file: f } : null; }))).filter(Boolean),
      reports: (await Promise.all((m.meta || []).filter(f => /^forward-report.*\.json$/.test(f)).map(async f => { const p = await g(f); return p ? { ...p, _file: f } : null; }))).filter(Boolean),
      scanlog: (m.meta || []).includes('scan-log.json') ? await g('scan-log.json') : null,
    };
    S.chain[m.id] = raw ? await verify(m.chain, raw) : null;
  }));
  return true;
}

// ---------- pembantu data ----------
const mesinById = id => S.cfg.mesin.find(m => m.id === id);
const rowsOf = id => S.sig.rows.filter(r => r.mesin === id);
const protoOf = id => pilihProtokol(S.meta[id]?.protos || []);
function basisRows(id, basis = S.basis) {
  const all = rowsOf(id), P = protoOf(id);
  if (basis === 'protokol' && P) return { rows: basisProtokol(all, P).kept, label: 'protokol', P };
  return { rows: all, label: P || basis === 'semua' ? 'semua baris' : 'semua baris (tanpa file protokol)', P };
}
const activeMesin = () => S.cfg.mesin.filter(m => m.aktif !== false && S.raw[m.id]);
const srcTs = id => {
  const m = S.meta[id]; if (!m) return null;
  const a = m.reports.map(r => Date.parse(r.dibuat)).filter(Number.isFinite);
  const b = m.scanlog?.length ? [Date.parse(m.scanlog.at(-1).iso)] : [];
  const all = [...a, ...b].filter(Number.isFinite); return all.length ? Math.max(...all) : null;
};

// ---------- header: kesegaran ----------
function renderFresh() {
  const lim = S.cfg.stale_jam, el = $('#fresh'); let html = '';
  for (const m of S.cfg.mesin) {
    const st = S.status.mesin?.[m.id];
    if (m.aktif === false) { html += `<span class="chip fail" title="${esc(m.catatan)}">${m.id}: tidak tersedia</span>`; continue; }
    const f = st?.fetchedAt ? Date.parse(st.fetchedAt) : null, s = srcTs(m.id);
    const hrsF = f ? (Date.now() - f) / 36e5 : Infinity, hrsS = s ? (Date.now() - s) / 36e5 : 0;
    const stale = !st?.ok || hrsF > lim || hrsS > lim;
    const txt = `${m.id}: ${f ? ago(f) : 'belum ada data'}${s ? ' (sumber ' + ago(s) + ')' : ''}`;
    html += `<span class="chip ${!st?.ok ? 'fail' : stale ? 'stale' : ''}" title="${esc(st?.error || '')}">${stale ? '⚠ ' : ''}${esc(txt)}${stale ? ' basi' : ''}</span>`;
  }
  el.innerHTML = html;
  const bad = S.cfg.mesin.filter(m => m.aktif !== false).filter(m => { const st = S.status.mesin?.[m.id], f = st?.fetchedAt ? Date.parse(st.fetchedAt) : null, s = srcTs(m.id); return !st?.ok || (Date.now() - f) / 36e5 > lim || (s && (Date.now() - s) / 36e5 > lim); }).length;
  $('#freshsum').innerHTML = bad ? `⚠ Kesegaran data: <b>${bad} mesin basi</b> (ketuk untuk detail)` : 'Kesegaran data: semua segar (ketuk untuk detail)';
  $('#freshbox').open = window.matchMedia('(min-width: 800px)').matches;
}

function renderBanner() {
  const stale = S.cfg.mesin.filter(m => m.aktif !== false).filter(m => { const st = S.status.mesin?.[m.id]; const f = st?.fetchedAt ? Date.parse(st.fetchedAt) : 0; return !st?.ok || (Date.now() - f) / 36e5 > S.cfg.stale_jam; });
  const shrink = S.cfg.mesin.filter(m => S.status.mesin?.[m.id]?.shrink);
  let h = '';
  if (stale.length) h += `<div class="callout">⚠ Data basi (&gt; ${S.cfg.stale_jam} jam atau penarikan gagal): <b>${stale.map(m => m.id).join(', ')}</b>. Angka di bawah memakai data terakhir yang berhasil ditarik.</div>`;
  if (shrink.length) h += `<div class="callout bad">Jumlah baris jurnal BERKURANG di: <b>${shrink.map(m => m.id).join(', ')}</b>. Lihat Audit (d) dan <code>data/snapshots/</code>.</div>`;
  $('#banner').innerHTML = h;
}

// ---------- 1. leaderboard ----------
function renderLeaderboard() {
  let body = '';
  for (const m of S.cfg.mesin) {
    if (m.aktif === false || !S.raw[m.id]) { body += `<tr><td class="l"><b>${m.id}</b></td><td colspan="11" class="l muted">tidak tersedia${m.catatan ? ' — ' + esc(m.catatan) : ''}</td></tr>`; continue; }
    const { rows, label } = basisRows(m.id), s = summarize(rows, S.biaya);
    const kembar = rows.filter(r => r.fork_bersama && COUNTED(r.status_monitor)).length;
    const ready = (() => { const P = protoOf(m.id); const need = P?.syarat_evaluasi || m.syarat_cadangan; return need ? (s.n_terisi >= need.min_trade_terisi && (s.ci_exp?.clusters || 0) >= need.min_minggu_berbeda) : false; })();
    body += `<tr>
      <td class="l"><b>${m.id}</b><span class="ci">${label}</span>${ready ? '' : '<span class="badge">belum layak dinilai</span>'}${s.kecil ? ' <span class="badge warn">sampel kecil</span>' : ''}</td>
      <td>${s.n_sinyal}${nTag(s.n_sinyal)}${s.n_open ? `<span class="ci">${s.n_open} open</span>` : ''}</td>
      <td>${s.n_terisi}<span class="ci">TP ${s.n_tp} · SL ${s.n_sl} · KED ${s.n_ked}</span></td>
      <td>${fmtP(s.fill_rate)}${nTag(s.n_selesai)}</td>
      <td>${fmtP(s.win_a)}${nTag(s.n_win_a)}${ciTxt(s.ci_a)}</td>
      <td>${fmtP(s.win_b)}${nTag(s.n_win_b)}${ciTxt(s.ci_b)}</td>
      <td class="${cls(s.avg_R_gross)}">${fmtR(s.avg_R_gross)}${nTag(s.n_terisi)}<span class="ci">sesudah biaya <span class="${cls(s.avg_R_net)}">${fmtR(s.avg_R_net)}</span></span></td>
      <td class="${cls(s.avg_R_net)}">${fmtR(s.avg_R_net)}${nTag(s.n_terisi)}${ciTxt(s.ci_exp, fmtR)}<span class="ci">${s.ci_exp?.clusters ?? 0} minggu</span></td>
      <td>${s.pf == null ? '–' : s.pf === Infinity ? '∞' : s.pf.toFixed(2)}${nTag(s.n_terisi)}</td>
      <td>${s.max_dd.toFixed(1)}R${nTag(s.n_terisi)}</td>
      <td>${kembar}${nTag(s.n_sinyal)}<span class="ci">${s.n_sinyal ? Math.round(kembar / s.n_sinyal * 100) : 0}% kembar fork</span></td>
    </tr>`;
  }
  $('#leaderboard').innerHTML = `<h2>Leaderboard</h2>
    <p class="muted">Basis: <b>${S.basis === 'protokol' ? 'Protokol (utama)' : 'Semua baris'}</b>. Semua angka R sesudah biaya ${costPct(S.biaya).toFixed(2)}% per trade kecuali kolom "Avg R" baris pertama. Win-rate hanya dari trade terisi. (a) TP vs SL; (b) kedaluwarsa terisi dihitung menang bila R sesudah biaya &gt; 0.</p>
    <div class="callout info">Mesin "belum layak dinilai" belum memenuhi syarat protokolnya. Angkanya hanya kemajuan, bukan bukti. tn, tnv2, tnv2c2, chatgpt berbagi baris awal yang identik (kolom "kembar fork"); keempatnya bukan sampel independen.</div>
    <div class="tbl"><table><thead><tr><th>Mesin</th><th>N sinyal</th><th>N terisi</th><th>Fill-rate</th><th>Win (a) TP/SL</th><th>Win (b) +KED</th><th>Avg R kotor</th><th>Expectancy (net)</th><th>Profit factor</th><th>Max DD</th><th>Baris kembar</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

// ---------- 2. progres protokol ----------
function renderProtokol() {
  let cards = '';
  for (const m of S.cfg.mesin) {
    if (m.aktif === false || !S.raw[m.id]) { cards += `<div class="card"><b>${m.id}</b><p class="muted">tidak tersedia</p></div>`; continue; }
    const protos = [...(S.meta[m.id]?.protos || [])].sort((a, b) => b.mulai_ms - a.mulai_ms);
    const list = protos.length ? protos : [null];
    list.forEach((P, i) => {
      const all = rowsOf(m.id);
      const kept = P ? basisProtokol(all, P).kept : all, s = summarize(kept, S.biaya);
      const need = P?.syarat_evaluasi || m.syarat_cadangan, weeks = s.ci_exp?.clusters ?? s.minggu;
      const rep = (S.meta[m.id]?.reports || []).find(r => r.protocol?.engine === P?.engine);
      const aktif = i === 0;
      let verdict = '<span class="badge">belum layak dinilai</span>';
      if (need && s.n_terisi >= need.min_trade_terisi && weeks >= need.min_minggu_berbeda) {
        verdict = s.ci_exp?.lo > 0 ? '<span class="badge good">LULUS (CI95 bawah &gt; 0)</span>' : '<span class="badge bad">TIDAK LULUS (CI95 bawah ≤ 0)</span>';
      }
      const pb = (v, tot) => `<div class="bar"><i style="width:${Math.min(100, tot ? v / tot * 100 : 0)}%"></i></div>`;
      cards += `<div class="card"><b>${m.id}</b> ${aktif ? '<span class="badge">protokol aktif</span>' : '<span class="badge">protokol lama</span>'} ${verdict}
        <div class="muted small">${P ? `${esc(P._file)} · agen ${esc(P.agen)} · engine <code>${esc(P.engine)}</code> · mulai ${esc(P.mulai?.slice(0, 16))}` : 'tidak ada file protokol'}${!P && need ? `<br>syarat dari ${esc(need.sumber)}` : ''}</div>
        ${need ? `<div style="margin-top:8px">Trade terisi (hitungan monitor): <b>${s.n_terisi}</b> / ${need.min_trade_terisi}</div>${pb(s.n_terisi, need.min_trade_terisi)}
        <div>Minggu berbeda: <b>${weeks}</b> / ${need.min_minggu_berbeda}</div>${pb(weeks, need.min_minggu_berbeda)}` : '<p class="muted">syarat tidak tersedia</p>'}
        <div class="small muted">Tercatat sesuai protokol: ${s.n_sinyal} (selesai ${s.n_selesai}, open ${s.n_open}).
        ${rep ? `<br>Laporan mesin (${esc(rep._file)}, ${esc(rep.dibuat?.slice(0, 16))}): terisi ${rep.progress?.trade_terisi?.[0]}, minggu ${rep.progress?.minggu?.[0]}, tercatat ${rep.counts?.tercatat_sesuai_protokol}${rep.counts?.terisi !== s.n_terisi ? ' <span class="badge warn">beda dari monitor</span>' : ''}` : '<br>Tidak ada laporan mesin yang cocok dengan protokol ini.'}</div>
        ${P?.kriteria_lulus ? `<details class="small muted"><summary>kriteria lulus</summary>${esc(P.kriteria_lulus)}</details>` : ''}
      </div>`;
    });
  }
  $('#protokol').innerHTML = `<h2>Progres protokol</h2><p class="muted">Syarat dibaca dari file protokol tiap mesin di <code>data/raw/&lt;mesin&gt;/</code>. Hitungan monitor memakai nilai ulang seragam; hitungan laporan mesin ditampilkan sebagai pembanding.</p><div class="grid">${cards}</div>`;
}

// ---------- 3. equity ----------
let chart = null; const hidden = new Set();
function renderEquity() {
  const el = $('#equity');
  const series = activeMesin().map((m, i) => {
    const { rows } = basisRows(m.id), f = rows.filter(r => FILLED(r.status_monitor)).sort((a, b) => exitT(a) - exitT(b));
    let c = 0; return { id: m.id, color: COLORS[S.cfg.mesin.indexOf(m) % COLORS.length], pts: f.map(r => ({ x: exitT(r), y: +(c += netR(r, S.biaya)).toFixed(3) })) };
  });
  el.innerHTML = `<h2>Equity curve (R kumulatif sesudah biaya)</h2>
    <p class="muted">Urut waktu keluar. Basis: ${S.basis === 'protokol' ? 'Protokol' : 'Semua baris'}. Kurva tn/tnv2/tnv2c2/chatgpt berimpit pada periode engine bersama karena baris identik.</p>
    <div class="row">${series.map(s => `<label><input type="checkbox" data-m="${s.id}" ${hidden.has(s.id) ? '' : 'checked'}><span class="sw" style="background:${s.color}"></span>${s.id} ${nTag(s.pts.length)}</label>`).join('')}</div>
    <div class="chartbox"><canvas id="eqc"></canvas></div>`;
  const draw = () => {
    if (!window.Chart) { $('#eqc').replaceWith(Object.assign(document.createElement('p'), { textContent: 'Chart.js gagal dimuat dari cdnjs.', className: 'muted' })); return; }
    chart?.destroy();
    const css = getComputedStyle(document.documentElement), grid = css.getPropertyValue('--line'), tx = css.getPropertyValue('--muted');
    chart = new window.Chart($('#eqc'), {
      type: 'line',
      data: { datasets: series.filter(s => !hidden.has(s.id)).map(s => ({ label: s.id, data: s.pts, borderColor: s.color, backgroundColor: s.color, stepped: 'before', pointRadius: 0, borderWidth: 1.8, parsing: false })) },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'nearest', intersect: false },
        scales: { x: { type: 'linear', ticks: { color: tx, maxTicksLimit: 8, callback: v => new Date(v).toISOString().slice(5, 10) }, grid: { color: grid } }, y: { title: { display: true, text: 'R kumulatif', color: tx }, ticks: { color: tx }, grid: { color: grid } } },
        plugins: { legend: { labels: { color: tx } }, tooltip: { callbacks: { title: i => fmtT(i[0].parsed.x), label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(2)}R` } } } },
    });
  };
  el.querySelectorAll('input[data-m]').forEach(i => i.addEventListener('change', () => { i.checked ? hidden.delete(i.dataset.m) : hidden.add(i.dataset.m); draw(); }));
  if (window.Chart) draw(); else window.addEventListener('load', draw, { once: true });
}

// ---------- 4. konsensus ----------
function renderKonsensus() {
  const rows = S.sig.rows.filter(r => r.arah && COUNTED(r.status_monitor)), ev = konsensus(rows, S.cfg.konsensus_jendela_jam * 36e5);
  const lv = k => ev.filter(e => (k === 1 ? e.level === 1 : e.level >= k));
  const line = (name, es) => {
    const rs = es.flatMap(e => e.rows), s = summarize(rs, S.biaya);
    return `<tr><td class="l">${name}</td><td>${es.length}</td><td>${s.n_terisi}${nTag(s.n_terisi)}</td><td>${fmtP(s.win_a)}${nTag(s.n_win_a)}${ciTxt(s.ci_a)}</td><td>${fmtP(s.win_b)}${nTag(s.n_win_b)}${ciTxt(s.ci_b)}</td><td class="${cls(s.avg_R_net)}">${fmtR(s.avg_R_net)}${nTag(s.n_terisi)}</td><td>${s.kecil ? '<span class="badge warn">sampel kecil</span>' : ''}</td></tr>`;
  };
  const last = ev.filter(e => e.level >= 2).sort((a, b) => b.t - a.t).slice(0, 40).map(e => `<tr><td class="l">${fmtT(e.t)}</td><td class="l">${esc(e.key.replace('|', ' '))}</td><td>${e.level}</td><td class="l">${e.sumber.join(', ')}</td><td class="l">${e.rows.map(r => r.status_monitor).join(', ')}</td></tr>`).join('');
  $('#konsensus').innerHTML = `<h2>Konsensus</h2>
    <p class="muted">Aset+arah yang sama dari ≥k <b>sumber independen</b> dalam jendela ${S.cfg.konsensus_jendela_jam} jam. Baris kembar antar fork (tn/tnv2/tnv2c2/chatgpt, aset+arah+t identik) dihitung <b>satu sumber</b>. Tiap sumber diwakili sinyal paling awalnya di jendela. Kategori ≥2/≥3/≥4 saling mencakup.</p>
    <div class="tbl"><table><thead><tr><th>Level</th><th>Kejadian</th><th>Trade terisi</th><th>Win (a)</th><th>Win (b)</th><th>Avg R net</th><th></th></tr></thead><tbody>
    ${line('1 sumber (tanpa konsensus)', lv(1))}${line('≥ 2 sumber', lv(2))}${line('≥ 3 sumber', lv(3))}${line('≥ 4 sumber', lv(4))}</tbody></table></div>
    <h3>Kejadian konsensus terbaru (≥2)</h3><div class="tbl"><table><thead><tr><th>Mulai (UTC)</th><th>Aset arah</th><th>Level</th><th>Sumber</th><th>Status monitor</th></tr></thead><tbody>${last || '<tr><td colspan="5" class="l muted">belum ada</td></tr>'}</tbody></table></div>`;
}

// ---------- 5. breakdown ----------
const DOW = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const DIMS = {
  aset: { l: 'Aset', f: r => r.aset }, arah: { l: 'Arah', f: r => r.arah },
  hari: { l: 'Hari (UTC)', f: r => DOW[new Date(r.t).getUTCDay()] }, jam: { l: 'Jam (UTC)', f: r => String(new Date(r.t).getUTCHours()).padStart(2, '0') },
  minggu: { l: 'Minggu (Senin UTC)', f: r => new Date(weekKey(r.t) * 7 * 864e5 + 4 * 864e5).toISOString().slice(0, 10) },
  kind: { l: 'Kind (crypto)', f: r => r.kind, only: 'crypto' }, tipe: { l: 'Tipe (crypto)', f: r => r.tipe, only: 'crypto' },
  mode: { l: 'Mode (crypto)', f: r => r.mode, only: 'crypto' }, tf: { l: 'TF (crypto)', f: r => r.tf, only: 'crypto' },
};
const bd = { m: 'semua', dim: 'aset' };
function renderBreakdown() {
  const ms = activeMesin();
  let rows = bd.m === 'semua' ? collapseFork(ms.flatMap(m => basisRows(m.id).rows)) : basisRows(bd.m).rows;
  const dim = DIMS[bd.dim], g = groupBy(rows.filter(r => COUNTED(r.status_monitor) && dim.f(r) != null), dim.f);
  const order = bd.dim === 'jam' || bd.dim === 'minggu' || bd.dim === 'hari' ? k => k : null;
  let items = [...g].map(([k, rs]) => [k, summarize(rs, S.biaya, { boot: false })]);
  items = order ? items.sort((a, b) => (bd.dim === 'hari' ? DOW.indexOf(a[0]) - DOW.indexOf(b[0]) : String(a[0]).localeCompare(String(b[0])))) : items.sort((a, b) => b[1].n_sinyal - a[1].n_sinyal);
  const body = items.map(([k, s]) => `<tr><td class="l">${esc(k)}${s.n_terisi && s.kecil ? ' <span class="badge warn">kecil</span>' : ''}</td><td>${s.n_sinyal}</td><td>${s.n_terisi}</td><td>${fmtP(s.fill_rate)}${nTag(s.n_selesai)}</td><td>${fmtP(s.win_a)}${nTag(s.n_win_a)}</td><td>${fmtP(s.win_b)}${nTag(s.n_win_b)}</td><td class="${cls(s.avg_R_net)}">${fmtR(s.avg_R_net)}${nTag(s.n_terisi)}</td><td class="${cls(s.total_R_net)}">${fmtR(s.total_R_net, 1)}</td></tr>`).join('');
  const dimOpts = Object.entries(DIMS).filter(([, d]) => !d.only || bd.m === d.only).map(([k, d]) => `<option value="${k}" ${k === bd.dim ? 'selected' : ''}>${d.l}</option>`).join('');
  $('#breakdown').innerHTML = `<h2>Breakdown</h2>
    <p class="muted">Deskriptif, bukan dasar kesimpulan. Pilihan "semua" menggabungkan mesin dan mengolapskan baris kembar fork. Basis: ${S.basis === 'protokol' ? 'Protokol' : 'Semua baris'}.</p>
    <div class="row"><label>Mesin <select id="bdm"><option value="semua">semua (fork dikolaps)</option>${ms.map(m => `<option ${m.id === bd.m ? 'selected' : ''}>${m.id}</option>`).join('')}</select></label>
    <label>Per <select id="bdd">${dimOpts}</select></label></div>
    <div class="tbl"><table><thead><tr><th>${dim.l}</th><th>N sinyal</th><th>N terisi</th><th>Fill-rate</th><th>Win (a)</th><th>Win (b)</th><th>Avg R net</th><th>Total R net</th></tr></thead><tbody>${body || '<tr><td colspan="8" class="l muted">tidak ada data</td></tr>'}</tbody></table></div>`;
  $('#bdm').value = bd.m;
  $('#bdm').onchange = e => { bd.m = e.target.value; if (DIMS[bd.dim].only && DIMS[bd.dim].only !== bd.m) bd.dim = 'aset'; renderBreakdown(); };
  $('#bdd').onchange = e => { bd.dim = e.target.value; renderBreakdown(); };
}

// ---------- 6. tabel sinyal ----------
const sg = { m: '', aset: '', st: '', from: '', to: '', limit: 200 };
const SIG_COLS = ['waktu_utc', 'mesin', 'aset', 'arah', 'entry', 'sl', 'tp', 'status_mesin', 'status_monitor', 'R_mesin', 'R_monitor', 'R_net', 'risk_pct', 'kembar_fork', 'tersegel', 'kind', 'tipe', 'mode', 'tf', 'engine', 'id'];
const decorate = r => ({ ...r, waktu_utc: fmtT(r.t), R_net: FILLED(r.status_monitor) ? +netR(r, S.biaya).toFixed(4) : '', kembar_fork: r.fork_bersama ? r.fork_bersama.join('+') : '', tersegel: r.sealed ? 'ya' : 'tidak' });
function sigFiltered() {
  return S.sig.rows.filter(r => (!sg.m || r.mesin === sg.m) && (!sg.aset || r.aset?.toLowerCase().includes(sg.aset.toLowerCase())) && (!sg.st || r.status_monitor === sg.st) &&
    (!sg.from || r.t >= Date.parse(sg.from + 'T00:00:00Z')) && (!sg.to || r.t < Date.parse(sg.to + 'T00:00:00Z') + 864e5)).sort((a, b) => b.t - a.t);
}
function renderSinyal() {
  const f = sigFiltered(), shown = f.slice(0, sg.limit).map(decorate);
  const sts = ['TP', 'SL', 'KEDALUWARSA_TERISI', 'TIDAK_TERISI', 'OPEN', 'NO_TRADE', 'TIDAK_VALID'];
  $('#sinyal').innerHTML = `<h2>Tabel sinyal</h2>
    <div class="row"><label>Mesin <select id="fm"><option value="">semua</option>${activeMesin().map(m => `<option ${sg.m === m.id ? 'selected' : ''}>${m.id}</option>`).join('')}</select></label>
    <label>Aset <input id="fa" size="8" value="${esc(sg.aset)}"></label>
    <label>Status <select id="fs"><option value="">semua</option>${sts.map(s => `<option ${sg.st === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Dari <input id="ff" type="date" value="${sg.from}"></label><label>Sampai <input id="ft" type="date" value="${sg.to}"></label>
    <button id="csv" type="button">Ekspor CSV (${f.length})</button></div>
    <div class="muted small">${f.length} baris cocok; menampilkan ${shown.length}. Seluruh baris yang cocok masuk CSV.</div>
    <div class="tbl"><table><thead><tr><th>Waktu (UTC)</th><th>Mesin</th><th>Aset</th><th>Arah</th><th>Entry</th><th>SL</th><th>TP</th><th>Status mesin</th><th>Status monitor</th><th>R mesin</th><th>R monitor</th><th>R net</th><th>Catatan</th></tr></thead><tbody>
    ${shown.map(r => `<tr><td class="l">${r.waktu_utc}</td><td class="l">${r.mesin}</td><td class="l">${esc(r.aset)}</td><td class="l">${r.arah ?? ''}</td><td>${r.entry}</td><td>${r.sl}</td><td>${r.tp}</td><td class="l">${r.status_mesin ?? '–'}</td><td class="l ${r.status_mesin && r.status_mesin !== r.status_monitor ? 'neg' : ''}">${r.status_monitor}</td><td>${r.R_mesin ?? '–'}</td><td>${r.R_monitor ?? '–'}</td><td class="${cls(r.R_net)}">${r.R_net === '' ? '–' : fmtR(r.R_net)}</td><td class="l small muted">${[r.kembar_fork && 'kembar: ' + r.kembar_fork, !r.sealed && 'tidak tersegel', r.catatan, r.grade_error].filter(Boolean).map(esc).join(' · ')}</td></tr>`).join('')}</tbody></table></div>
    ${f.length > shown.length ? '<button id="more" type="button">Tampilkan 200 lagi</button>' : ''}`;
  const bind = (id, k, ev = 'change') => { $(id).addEventListener(ev, e => { sg[k] = e.target.value; sg.limit = 200; renderSinyal(); if (id === '#fa') { const i = $('#fa'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); };
  bind('#fm', 'm'); bind('#fs', 'st'); bind('#ff', 'from'); bind('#ft', 'to'); bind('#fa', 'aset', 'input');
  $('#more')?.addEventListener('click', () => { sg.limit += 200; renderSinyal(); });
  $('#csv').addEventListener('click', () => {
    const blob = new Blob([toCSV(f.map(decorate), SIG_COLS)], { type: 'text/csv' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `sinyal-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

// ---------- 7. audit ----------
function renderAudit() {
  const rows = S.sig.rows, now = Date.now();
  const tbl = (head, body) => `<div class="tbl"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td class="l muted" colspan="${head.length}">tidak ada</td></tr>`}</tbody></table></div>`;
  // (a) status berbeda
  const cmp = rows.filter(r => r.status_mesin);
  const diff = cmp.filter(r => r.status_mesin !== r.status_monitor);
  const rdiff = cmp.filter(r => r.status_mesin === r.status_monitor && FILLED(r.status_monitor) && r.R_mesin != null && Math.abs(r.R_mesin - r.R_monitor) > 0.05);
  const pairs = groupBy(diff, r => `${r.mesin}: ${r.status_mesin} → ${r.status_monitor}`);
  const reason = (m, a, b) => (m === 'dseek' && a === 'TIDAK_TERISI') || (m === 'tnv2c2' && a === 'TIDAK_TERISI') ? 'kemungkinan aturan pembatalan mesin (72 jam / TP tanpa isi) yang tidak dipakai monitor' : a === 'OPEN' ? 'mesin belum menilai, monitor sudah' : b === 'OPEN' ? 'monitor belum final (candle belum cukup / gagal ambil)' : 'periksa manual';
  const pairRows = [...pairs].sort((x, y) => y[1].length - x[1].length).map(([k, rs]) => `<tr><td class="l">${esc(k)}</td><td>${rs.length}</td><td class="l small muted">${reason(rs[0].mesin, rs[0].status_mesin, rs[0].status_monitor)}</td></tr>`).join('');
  const diffRows = diff.slice(0, 150).map(r => `<tr><td class="l">${r.mesin}</td><td class="l">${esc(r.id)}</td><td class="l">${r.status_mesin}</td><td class="l">${r.status_monitor}</td><td>${r.R_mesin ?? '–'}</td><td>${r.R_monitor ?? '–'}</td></tr>`).join('');
  const tot = cmp.length;
  // (b) rantai
  const chainRows = S.cfg.mesin.map(m => {
    if (m.aktif === false) return `<tr><td class="l">${m.id}</td><td colspan="5" class="l muted">tidak tersedia</td></tr>`;
    const c = S.chain[m.id], rep = (S.meta[m.id]?.reports || []).find(r => r.chain?.head === c?.head);
    const repChain = (S.meta[m.id]?.reports || []).map(r => `${r._file}: n=${r.chain?.n}, ujung ${r.chain?.head}`).join('<br>');
    return `<tr><td class="l">${m.id}</td><td>${c ? (c.ok === null ? '<span class="badge">tidak ada chain</span>' : c.ok ? '<span class="badge good">utuh</span>' : '<span class="badge bad">RUSAK</span>') : '–'}</td><td>${c?.n ?? 0}</td><td>${c?.tidak_tersegel ?? 0}</td><td class="l"><code>${c?.head ?? '–'}</code>${rep ? ' <span class="badge good">= ujung laporan mesin</span>' : ''}</td><td class="l small muted">${(c?.errors || []).slice(0, 3).map(e => esc(e.id + ': ' + e.msg)).join('<br>')}${repChain ? '<br>laporan mesin: ' + repChain : ''}</td></tr>`;
  }).join('');
  // (c) tidak lengkap
  const inc = rows.filter(r => r.status_monitor === 'TIDAK_VALID' || r.grade_error || !r.sealed);
  const incG = groupBy(inc, r => `${r.mesin}: ${r.status_monitor === 'TIDAK_VALID' ? 'TIDAK_VALID (' + (r.catatan || '?') + ')' : r.grade_error ? 'gagal ambil candle (' + r.grade_error + ')' : 'tidak tersegel'}`);
  const incRows = [...incG].map(([k, rs]) => `<tr><td class="l">${esc(k)}</td><td>${rs.length}</td><td class="l small muted">${rs.slice(0, 3).map(r => esc(r.id)).join(', ')}</td></tr>`).join('');
  // (d) selisih jumlah baris
  const cntRows = S.cfg.mesin.map(m => {
    if (m.aktif === false) return '';
    const c = S.sig.counts[m.id], st = S.status.mesin?.[m.id], rep = (S.meta[m.id]?.reports || [])[0];
    const sealedRaw = S.raw[m.id]?.filter(r => r.fwd || (m.chain === 'crypto' && r.h)).length;
    const nonCounted = rowsOf(m.id).filter(r => !COUNTED(r.status_monitor)).length;
    const ok = c.baris_mesin === c.baris_monitor + c.duplikat_dibuang;
    return `<tr><td class="l">${m.id}</td><td>${c.baris_mesin}</td><td>${c.duplikat_dibuang}</td><td>${c.baris_monitor}</td><td>${nonCounted}</td><td>${sealedRaw ?? '–'}</td><td>${rep?.chain?.n ?? '–'}</td><td class="l">${ok ? '' : '<span class="badge bad">tidak cocok</span> '}${st?.shrink ? `<span class="badge bad">berkurang ${st.shrink.dari}→${st.shrink.ke}</span>` : ''}${rep?.chain?.n != null && sealedRaw != null && rep.chain.n !== sealedRaw ? '<span class="badge warn">laporan ≠ jurnal (beda waktu tarik)</span>' : ''}</td></tr>`;
  }).join('');
  // (e) menunggu lewat due
  const late = rows.filter(r => (r.status_mesin === 'OPEN' || r.status_monitor === 'OPEN') && r.due < (S.sig.now_ms ?? now));
  const lateRows = late.slice(0, 100).map(r => `<tr><td class="l">${r.mesin}</td><td class="l">${esc(r.id)}</td><td class="l">${fmtT(r.due)}</td><td class="l">${r.status_mesin ?? '–'}</td><td class="l">${r.status_monitor}</td><td class="l small muted">${esc(r.grade_error || '')}</td></tr>`).join('');

  $('#audit').innerHTML = `<h2>Audit data</h2>
    <h3>(a) Status mesin ≠ status monitor <span class="n">${diff.length} dari ${tot} baris yang punya status mesin</span></h3>
    ${tbl(['Pasangan', 'Jumlah', 'Penjelasan'], pairRows)}
    <div class="muted small">Selisih R &gt; 0,05 pada status yang sama: <b>${rdiff.length}</b>${rdiff.length ? ' (contoh: ' + rdiff.slice(0, 3).map(r => esc(r.id) + ' ' + r.R_mesin + ' vs ' + r.R_monitor).join('; ') + ')' : ''}</div>
    ${diff.length ? `<details><summary class="small">Daftar (maks 150)</summary>${tbl(['Mesin', 'id', 'Status mesin', 'Status monitor', 'R mesin', 'R monitor'], diffRows)}</details>` : ''}
    <h3>(b) Integritas hash-chain (dihitung di browser dari data/raw)</h3>
    ${tbl(['Mesin', 'Status', 'Baris tersegel', 'Tidak tersegel', 'Ujung rantai', 'Keterangan'], chainRows)}
    <h3>(c) Sinyal tanpa data lengkap / tidak valid / tidak tersegel</h3>
    ${tbl(['Kategori', 'Jumlah', 'Contoh id'], incRows)}
    <h3>(d) Selisih jumlah baris mesin vs monitor</h3>
    ${tbl(['Mesin', 'Baris di mesin', 'Duplikat dibuang', 'Baris di monitor', 'Bukan sinyal (NO_TRADE/tidak valid)', 'Tersegel di jurnal', 'n di laporan mesin', 'Catatan'], cntRows)}
    <div class="muted small">Dedupe kunci aset+arah+t per mesin. Baris kembar antar fork <b>tidak</b> dibuang di sini (tiap mesin tetap punya barisnya) tetapi ditandai dan dikolaps di Konsensus/Breakdown "semua".</div>
    <h3>(e) Hasil "menunggu" yang sudah lewat due <span class="n">${late.length}</span></h3>
    ${tbl(['Mesin', 'id', 'Due (UTC)', 'Status mesin', 'Status monitor', 'Error'], lateRows)}`;
}

// ---------- navigasi ----------
const RENDER = { leaderboard: renderLeaderboard, protokol: renderProtokol, equity: renderEquity, konsensus: renderKonsensus, breakdown: renderBreakdown, sinyal: renderSinyal, audit: renderAudit, aturan: () => {} };
function show() {
  const id = (location.hash || '#leaderboard').slice(1), tab = RENDER[id] ? id : 'leaderboard';
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === tab));
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + tab));
  if (S.sig) { try { RENDER[tab](); } catch (e) { console.error(e); $('#' + tab).innerHTML = `<div class="callout bad">Gagal menampilkan: ${esc(e.message)}</div>`; } }
}

async function main() {
  try { const b = localStorage.getItem('basis'); if (b) { S.basis = b; $('#basis').value = b; } } catch { /* abaikan */ }
  $('#basis').onchange = e => { S.basis = e.target.value; try { localStorage.setItem('basis', S.basis); } catch { /* abaikan */ } show(); };
  window.addEventListener('hashchange', show);
  const ok = await load();
  if (!ok) { $('#banner').innerHTML = '<div class="callout bad">Belum ada <code>data/signals.json</code>. Jalankan workflow "Update monitor" dari tab Actions (Run workflow), lalu muat ulang halaman.</div>'; show(); return; }
  renderFresh(); renderBanner(); show();
  $('#foot').textContent = `Data dibuat ${S.sig.generatedAt} · aturan grading: ${S.sig.aturan} · ${S.sig.rows.length} baris · error ambil candle: ${S.sig.grade_errors}`;
}
main();
