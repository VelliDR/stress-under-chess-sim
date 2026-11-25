# Content, Art, Narrative & Brand License (`LICENSE-CONTENT`)

**Copyright © 2026 VelliDR. All Rights Reserved (except where explicitly stated below).**

---

## 1. Split-Licensing Overview (Code vs. Creative Game Content)

**S.U.C.S. — Stress Under Chess Simulator** uses a standard dual-layer licensing model used by independent open-source games to keep the software openly auditable while protecting the creator's original artwork, writing, lore, and brand identity:

| Scope | Files / Assets Covered | License |
| :--- | :--- | :--- |
| **Source Code & Engine** | `src/engine/`, `src/ai/`, `src/audio/`, `src/storage/`, `src/ui/`, `src/main.ts`, `tests/`, build & config files | **GNU AGPL-3.0-only** ([LICENSE](./LICENSE)) |
| **Original Game Content, Narrative, Lore & Artwork** | `src/data/narrative.ts` (original Turkish/dual-tone dialogue & quotes), `src/data/encounters.ts` & `src/data/factions.ts` (original lore/flavor text), `src/render/pieceSprites24.ts` / `tileSprites32.ts` / `pixelArt.ts` (original pixel-art matrices), `public/favicon.svg`, `docs/images/*`, `GUIDEBOOK.md`, `tasarım.md`, `v2.md`, `v2_yama.md` | **CC BY-NC-ND 4.0** (Attribution-NonCommercial-NoDerivatives 4.0 International) |
| **Brand, Title & Trademarks** | *"S.U.C.S."*, *"Stress Under Chess Simulator"*, *"Büyükusta-OS"*, *"Kimyager-OS"*, *"Stres Seferi"*, *"Taktik Kriz"*, *"Yüz Yüze Panik"*, and the cracked-crown sweating Pixel King logo | **All Rights Reserved** by **VelliDR** |
| **Third-Party Font** | `@fontsource/pixelify-sans` (bundled via npm) | **SIL Open Font License 1.1 (OFL-1.1)** |

---

## 2. What This Means in Practice (Özet — Türkçe)

- **Kaynak Kod (GNU AGPL-3.0):** Kodu inceleyebilir, yerel olarak çalıştırabilir, hata düzeltebilir ve AGPL-3.0 şartlarına uyarak paylaşabilirsiniz. Ancak kodu değiştirip kendi web sitenizde/sunucunuzda yayınlarsanız, **tüm değişikliklerin kaynak kodunu AGPL-3.0 altında açıkça paylaşmak** ve telif bildirimini korumak zorundasınız. Kapalı kaynak ticari klon üretilemez.
- **Oyun İçeriği, Diyaloglar, Piksel Sanat ve Rehberler (CC BY-NC-ND 4.0):**
  - **Atıf (BY):** Yaratıcı olarak **VelliDR** ve proje deposu açıkça belirtilmelidir.
  - **Ticari Olmayan (NC):** Yazılı izin olmadan ticari amaçla (reklamlı oyun portalları, ücretli satış, mağaza dağıtımı vb.) kullanılamaz.
  - **Türetilemez (ND):** Orijinal diyaloglar, piksel-art çizimler ve hikâye içerikleri değiştirilerek ayrı bir ticari/yeniden markalanmış oyun gibi dağıtılamaz.
- **Marka ve İsim Hakları:** Kodun çatallanmış (fork) kopyaları, VelliDR'nin yazılı izni olmadan *"S.U.C.S."* veya *"Stress Under Chess Simulator"* adıyla ya da resmi proje izlenimi verecek logo/markayla yayınlanamaz.

---

## 3. Commercial Licensing & Permissions

If you wish to host, publish, port, or use **S.U.C.S.** code, artwork, narrative, or branding commercially outside the terms of AGPL-3.0 / CC BY-NC-ND 4.0, please contact **VelliDR** via GitHub (`https://github.com/VelliDR/stress-under-chess-sim`) to request a separate written license agreement.

> *Legal Notice:* Copyright protects creative expression (source code, pixel artwork, narrative text, documentation, and visual assets) and trademark/brand identity. Abstract game rules or ideas themselves are not covered by copyright law; this dual license provides the strongest standard legal protection available for open GitHub game repositories.
