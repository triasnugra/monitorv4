# Monitor 7 Mesin

Situs statis (GitHub Pages) yang **mengukur** 7 mesin analisis trading. Tidak mengubah mesin, tidak menambah hipotesis.

- `scripts/fetch.mjs` menarik jurnal tiap mesin ke `data/raw/` (snapshot, tandai basi bila gagal)
- `scripts/grade.mjs` menilai ulang semua sinyal dengan `scripts/trade-sim.mjs` (aturan dasar) -> `data/signals.json`
- `index.html` + `assets/*.js` menghitung semua metrik di browser; `test/test.mjs` menguji logika
- `.github/workflows/update.yml`: cron 30 menit -> tes -> tarik -> nilai -> commit data -> deploy Pages
- `extras/`: opsional untuk repo grox

Pengaturan (mesin, biaya, ambang basi) ada di `config.json`.
