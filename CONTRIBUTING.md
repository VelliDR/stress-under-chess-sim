# S.U.C.S. Katkı Rehberi (Contributing Guidelines)

**S.U.C.S. (Stress Under Chess Simulator)** projesine katkıda bulunmayı düşündüğünüz için teşekkürler! Bu doküman geliştirme ortamı, zorunlu mimari kurallar ve Pull Request akışını özetler.

---

## 1. Hızlı Kurulum

Gereksinim: **Node.js 20+** ve **npm**

```bash
git clone https://github.com/VelliDR/stress-under-chess-sim.git
cd stress-under-chess-sim
npm install
npm run dev
```

Değişiklik göndermeden önce aşağıdaki doğrulamaların tamamı hatasız geçmelidir:

```bash
npm run build   # tsc --noEmit && tsc -p tsconfig.engine.json --noEmit && vite build
npm test        # Tüm Vitest birim ve entegrasyon testleri
```

---

## 2. Zorunlu Mimari Kurallar

S.U.C.S. katı determinizm ve hilesiz savaş sisi ilkeleri üzerine kuruludur. Tüm Pull Request'lerde aşağıdaki **5 değişmez kural** korunmalıdır:

1. **Saf Headless Motor (`src/engine/`):** `src/engine/` altında hiçbir DOM, Canvas, `window`, `document`, `performance` veya `requestAnimationFrame` referansı bulunamaz (`tsconfig.engine.json` bunu derleme zamanında zorlar).
2. **Sıfır `Math.random()`:** Tüm rastgelelik `src/engine/prng.ts` (`mulberry32`) üzerinden `state.rngState` ile deterministik akmalıdır.
3. **Saf JSON State:** `GameState` ve `AppRunState` yalnızca JSON-serileştirilebilir düz nesneler, diziler ve ilkel tipler içerir (`Map`, `Set`, `Date`, sınıf örneği yasaktır).
4. **Görüş İzolasyonu (Anti-Cheat):** Hem `CanvasRenderer` hem de yapay zeka (`src/ai/`) yalnızca `getVisibleState(...)` çıktısını tüketebilir; ham `GameState` içindeki gizli düşman bilgilerine erişemez.
5. **%100 Çevrimdışı & Pointer Events:** Harici CDN, uzaktan font/görsel/ses bağımlılığı eklemeyin. Tüm tahta girdileri fare ve dokunmatik için **Pointer Events** ile yazılmalı; kritik bilgiler yalnızca hover'a bağımlı olmamalıdır.

---

## 3. Hata Bildirimi ve Özellik Önerisi

- Bir hata bildirirken `.github/ISSUE_TEMPLATE/bug_report.yml` şablonunu kullanın ve mümkünse **Seed**, **Durum Özeti (`#HASH`)** ile **Oyun Modu** bilgisini ekleyin.
- Yeni mekanik, taş veya büyük arayüz değişiklikleri için kod yazmadan önce bir **Özellik Önerisi (Issue)** açıp tartışmanız önerilir.
- Tüm etkileşimlerde [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) kuralları geçerlidir.

---

## 4. Pull Request Süreci & Lisans Onayı

1. `main` dalından anlamlı bir isimle yeni dal açın (ör. `fix/ice-slide-pit` veya `feat/hud-toast-polish`).
2. Değişikliğinizi kapsayan **Vitest** testlerini `tests/` altında ekleyin veya güncelleyin.
3. `npm run build` ve `npm test` komutlarının temiz geçtiğini doğrulayın.
4. PR açıklamasında `.github/PULL_REQUEST_TEMPLATE.md` kontrol listesini doldurun.

### Lisans ve Katkı Onayı

Bu depoya bir Pull Request veya kod katkısı göndererek, katkınızın:
- Kod kısımları için **[GNU AGPL-3.0-only](./LICENSE)** lisansı altında,
- Oyun içi yaratıcı içerik, görsel, anlatı veya dokümantasyon katkıları için **[LICENSE-CONTENT.md](./LICENSE-CONTENT.md)** şartları altında

dağıtılmasını kabul etmiş ve bu katkıyı sunma yetkisine sahip olduğunuzu beyan etmiş olursunuz.
