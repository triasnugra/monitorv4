// Scan headless grox -> data/journal.json. Meniru Desk.tsx: run() -> judge() -> toJournalRow() -> gradeTrade().
// Dijalankan: node --experimental-strip-types scripts/grox-scan.mts   (Node >= 22.6)
// Jurnal bersifat tambah-saja; baris lama tidak diubah kecuali hasilnya dinilai ulang.
import fs from 'node:fs';
import { analyze } from '../src/lib/engine/analyze.ts';
import { calendarHolds } from '../src/lib/engine/calendar.ts';
import { gradeTrade, isActive, mapK } from '../src/lib/engine/grade.ts';
import { judge } from '../src/lib/engine/gates.ts';
import { binance, klines, topUsdt } from '../src/lib/engine/market.ts';
import { scanInput } from '../src/lib/engine/math.ts';
import type { JournalRow } from '../src/lib/engine/types.ts';

const FILE = 'data/journal.json', DAY = 864e5;
type Out = { id: string; t: number; due: number; agen: string; aset: string; arah: 'LONG' | 'SHORT'; entry: number; sl: number; tp: number; alasan: string; hasil: string; R: number | ''; engine: string; tx?: number };
const old: Out[] = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : [];
const toRow = (o: Out): JournalRow => ({ id: o.id, symbol: o.aset, side: o.arah, entry: o.entry, sl: o.sl, tp: o.tp, alasan: o.alasan, t: o.t, due: o.due, hasil: o.hasil as JournalRow['hasil'], R: o.R === '' ? null : o.R });

// 1) nilai ulang baris yang masih menunggu
for (const o of old.filter(o => o.hasil === 'menunggu')) {
  try {
    const t0 = Math.floor(o.t / 36e5) * 36e5;
    const g = await gradeTrade({ arah: o.arah, entry: o.entry, sl: o.sl, tp: o.tp, t: o.t, due: o.due }, {
      h1: async () => ((await binance(`klines?symbol=${o.aset}USDT&interval=1h&startTime=${t0}&limit=1000`)) as number[][]).map(mapK),
      m1: async (a, b) => ((await binance(`klines?symbol=${o.aset}USDT&interval=1m&startTime=${a}&endTime=${b}&limit=1000`)) as number[][]).map(mapK),
    });
    if (g) { o.hasil = g.hasil; o.R = +g.R.toFixed(2); o.tx = g.t; }
  } catch (e) { console.log('nilai gagal', o.id, String(e)); }
}

// 2) scan 40 koin teratas + BTC
const symbols = await topUsdt(40);
if (!symbols.includes('BTC')) symbols.unshift('BTC');
const analyses = [] as ReturnType<typeof analyze>[];
for (let i = 0; i < symbols.length; i += 6) {
  const part = await Promise.all(symbols.slice(i, i + 6).map(async s => { try { const sc = scanInput(await klines(`${s}USDT`)); return analyze(sc.bars, sc.qv, sc.analyzedAt, s); } catch { return null; } }));
  analyses.push(...(part.filter(Boolean) as typeof analyses));
}
if (!analyses.length) { console.log('tidak ada koin yang bisa dinilai; jurnal tidak diubah'); process.exit(0); }
const rowId = (a: (typeof analyses)[number]) => `${new Date(a.analyzedAt).toISOString().slice(0, 10)}|${a.symbol}|${a.legacySide === 1 ? 'LONG' : 'SHORT'}`;
const scanIds = new Set(analyses.map(rowId));
const active = new Set<string>();
for (const o of old) if (isActive(toRow(o)) && !scanIds.has(o.id)) active.add(o.aset);
const btcTrend = analyses.find(a => a.symbol === 'BTC')?.tr ?? 0;
const holds = calendarHolds();
const known = new Set(old.map(o => o.id)), add: Out[] = [];
for (const a of analyses) {
  const d = judge(a, { btcTrend, active, calendar: holds });
  if (d.verdict !== 'eksekusi' || a.entry == null || a.sl == null || a.tp == null) continue;
  const id = rowId(a); if (known.has(id)) continue;
  add.push({ id, t: a.analyzedAt, due: a.analyzedAt + 7 * DAY, agen: 'grox', aset: a.symbol, arah: a.legacySide === 1 ? 'LONG' : 'SHORT', entry: a.entry, sl: a.sl, tp: a.tp, alasan: d.parts.join(', '), hasil: 'menunggu', R: '', engine: 'grox-engine' });
}
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify([...add, ...old], null, 1));
console.log(`baris baru ${add.length}, total ${add.length + old.length}`);
