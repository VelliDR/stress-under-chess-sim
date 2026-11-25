# PROJE ŞARTNAMESİ v2: TACTICAL FOG CHESS (2D Roguelike & Asimetrik Ordu Satrancı)

Sen kıdemli bir oyun mimarı, algoritma mühendisi ve TypeScript geliştiricisisin. Sıfırdan, tarayıcıda %100 çevrimdışı (offline-first) çalışabilen, deterministik, test odaklı ve temiz mimarili bir 2D taktiksel satranç oyunu inşa edeceğiz.

Bu doküman projenin tek doğruluk kaynağıdır (Single Source of Truth). Kodlamaya geçmeden önce tüm kuralları ve uç durumları sindir. **Bölüm 10'daki Faz Planına harfiyen uy ve benden açık onay almadan bir sonraki faza geçme.**

---

## 1. OYUN VİZYONU VE ÇEKİRDEK KURALLAR

Klasik satrancı dört ana mekanikle birleştiren sıra tabanlı bir taktik oyunu:
1. **Sefer Modu (Tek Kişilik Roguelike):** Küçük bir mangayla başla, bölümleri geçtikçe orduyu büyüt, taşlara mutasyon ekle, risk-ödül pazarlıkları yap ve Boss'u yen.
2. **Asimetrik Ordu ve Gelişen Düello (1v1 Skirmish — Best of 3):** Bütçeyle gizli ordu kur, el aralarında geri dönüş dengeli (loser-picks-better) kartlarla ordunu evrimleştir.
3. **Etkileşimli Arazi:** Hareket fiziğini ve görüş hattını değiştiren harita kareleri.
4. **Adil Savaş Sisi (Fog of War):** Keşif ve pusu gerilimi veren ama karanlıktan tek hamlede haksız ölümü önleyen sistem.

### Klasik Satrançtan Farklılaşan Temel Kurallar
* **Kazanma Koşulu — Şahı Ele Geçirme (King Capture):** Savaş sisi ve buz fiziği nedeniyle klasik "şah çekme/pat yasaklama" yoktur. Şah tehdit altındaki kareye yürüyebilir; rakip Şahı yiyen (veya çukura/ateşe sürerek öldüren) taraf kazanır.
* **Piyon Hareketi ve Terfi:** Oyuncu (`PLAYER`) piyonları daima `-y` (yukarı), düşman (`ENEMY`) piyonları daima `+y` (aşağı) ilerler. Henüz hareket etmemiş (`hasMoved === false`) piyon 2 kare ilerleyebilir (aradaki kare boş ve geçilebilir olmak şartıyla). Karşı son sıraya (`y === 0` veya `y === height - 1`) ulaşan piyon otomatik olarak **Vezir**'e terfi eder (Sefer ve Düello'da terfi seçeneği modalı opsiyoneldir, MVP'de Vezir + traitlerini korur). Rok ve En Passant kapalıdır.
* **Pas Geçme (Anti-Softlock):** Sırası gelen tarafın tüm taşları donmuşsa veya geçerli hamlesi kalmamışsa `END_TURN` aksiyonu ile turu pas geçebilir (şah düşmediği sürece oyun kilitlenmez).

---

## 2. TEKNOLOJİ YIĞINI VE KATI MİMARİ SÖZLEŞMELER

* **Yığın:** TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), Vite, HTML5 Canvas 2D (harici oyun motoru yok), Vanilla TS + temiz CSS (harici UI framework yok), Vitest.
* **Sıfır Harici Bağımlılık (Offline-First):** Harici font, CDN, resim veya ses dosyası kullanma.
  * Taşlar, arazi desenleri (renk körlüğü dostu geometrik dokular dahil) ve trait rozetleri Canvas 2D vektör çizimleriyle üretilecek (`devicePixelRatio` destekli).
  * Ses efektleri saf **Web Audio API** ile sentezlenecek (sessize alma / ses düzeyi kontrolü ile).
* **Girdi (Fare + Dokunmatik):** Tüm tahta etkileşimleri Mouse Events yerine **Pointer Events** (`pointerdown`, `pointermove`, `pointerup`) ile yazılacak. Kritik bilgi sadece hover'a bağlı olmayacak; bir kareye/taşa dokunmak veya tıklamak da inceleme panelini güncelleyecek.

### 5 Zorunlu Mimari Kural (Test Edilebilirlik ve İleride QR/WebRTC 2 Oyunculu İçin)
1. **Headless Motor:** `src/engine/` altında DOM, Canvas, `window`, `performance` veya `requestAnimationFrame` referansı **kesinlikle yasaktır**.
2. **Saf JSON State (`JSON-Serializable Only`):** `GameState` ve `AppRunState` içinde `Map`, `Set`, `Date`, fonksiyon veya sınıf örneği (`class`) **yasaktır**. Sadece düz nesneler (`Record`), diziler ve ilkel tipler kullanılır. Bu sayede `localStorage` kaydı, geri alma (undo) ve ilerideki ağ senkronizasyonu kırılmaz.
3. **Olay Üreten Saf Reducer Sözleşmesi:** Motor durumu doğrudan değiştirmez ve her hamlede arayüz/ses katmanının oynatacağı sıralı bir olay listesi döner:
   ```ts
   export interface StepResult {
     nextState: GameState;
     events: GameEvent[];
     error?: string; // Geçersiz aksiyonda state değişmez, sebep döner
   }

   export function stepGame(state: GameState, action: GameAction): StepResult;
   ```
   `GameEvent` tipleri: `PIECE_MOVED`, `PIECE_SLID`, `SHIELD_BROKEN`, `PIECE_CAPTURED`, `PIECE_FELL_IN_PIT`, `PIECE_BURNED`, `PIECE_FROZEN`, `PIECE_PUSHED`, `TILE_IGNITED`, `TILE_EXTINGUISHED`, `WALL_DESTROYED`, `ENEMY_ALERTED`, `UNIT_SPAWNED`, `PIECE_PROMOTED`, `TURN_CHANGED`, `MATCH_ENDED`.
4. **Deterministik PRNG + Aksiyon Kaydı + Durum Özeti:**
   * Kodun hiçbir yerinde `Math.random()` kullanılmaz; her şey `src/engine/prng.ts` (`mulberry32`) üzerinden `state.rngState` güncellenerek akar.
   * Yapılan her geçerli aksiyon `state.actionHistory` dizisine eklenir (deterministik tekrar oynatma ve hata ayıklama için).
   * `computeStateHash(state)` (FNV-1a 32-bit) fonksiyonu sağlanır (iki cihaz senkronizasyonu ve regresyon testleri için).
5. **Görüş İzolasyonu:** Hem Canvas Renderer hem de Yapay Zeka, ham `GameState` yerine `getVisibleState(state, side)` çıktısını tüketir.

---

## 3. EKRAN AKIŞI VE ÜST DURUM MAKİNESİ (`AppState`)

Uygulama tek bir üst durum makinesiyle yönetilir (`saveVersion: 1`):
* `MAIN_MENU` → Mod seçimi (Sefer / Gelişen Düello / Sandbox / Devam Et), Seed girişi (veya bugünün tarihinden üretilen "Günlük Seed"), Ayarlar (Ses, Animasyon Hızı 1x/2x, Niyet Okları Aç/Kapa).
* **Sefer Akışı:** `SQUAD_SELECT` → `BATTLE` → (kazanırsa) `CAMPAIGN_REWARD` → sonraki oda → ... → `BOSS_BATTLE` → `RUN_VICTORY` / `RUN_DEFEAT`.
* **Düello Akışı (Best of 3):** `SKIRMISH_DEPLOY` (20 puanlık bütçeyle ordu kurma + gizli yerleştirme) → `BATTLE` → `SKIRMISH_DRAFT` (el arası kart seçimi) → sonraki el (yeni harita, güncel ordular) → `MATCH_SUMMARY`.
* **Sandbox Akışı:** İki tarafı da elle oynayabileceğimiz, sis perspektifini değiştirebileceğimiz (`PLAYER` / `ENEMY` / `OMNISCIENT`) ve hamle geri alabileceğimiz (`UNDO`) test alanı.

---

## 4. ARAZİ, SAVAŞ SİSİ VE MUTASYONLAR (KESİN UÇ DURUM KURALLARI)

### A. Arazi Tipleri (`TileType`) ve Görsel Desenler
| Arazi | Hareket & Fizik | Görüş (LOS) | Renk + Desen |
| :--- | :--- | :--- | :--- |
| `PLAIN` | Normal. | Açık. | Arduvaz dama (`#1e222a` / `#262b36`). |
| `WALL` | Geçilemez. Sadece At üstünden atlayabilir (üzerine inemez). | **Görüşü keser.** | Koyu taş `#4a505c` + tuğla çizgileri. |
| `PIT` | Yürünemez. Sadece At üstünden atlayabilir. Kayarak veya itilerek giren taş **yok olur**. | Açık. | Siyah boşluk `#0b0d12` + iç gölge. |
| `ICE` | Üzerine kayarak/yürüyerek giren taş (At zıplaması hariç) geldiği yön birim vektöründe `(dx, dy)` kayar. `FROST_WARDENS` etkilenmez. | Açık. | Buz mavisi `#38bdf8` + çapraz parıltı çizgileri. |
| `WATCHTOWER` | Normal. Üzerindeki taşın görüş yarıçapına **+2** ekler. | Açık. | Altın çerçeve `#f59e0b` + köşe kule ikonu. |
| `BURNING` | Geçilebilir/durulabilir (kalan süre: `burnTurns`, varsayılan 2). | Açık. | Turuncu-kırmızı `#f97316` + alev ikonu. |

**Buz Kayma Kuralları (Kesinleştirilmiş):**
* At zıplayarak bir `ICE` karesine inerse o karede durur (geliş yön vektörü yoktur, kaymaz).
* Yürüyen/kayan taş `ICE` karesine girerse, her adımda `(x + dx, y + dy)` kontrol edilir (sonsuz döngüye karşı sert limit: `MAX_SLIDE_STEPS = 16`):
  1. Tahta dışı, `WALL` veya dost taş varsa → bir önceki karede durur.
  2. `PLAIN` veya `WATCHTOWER` veya `BURNING` ise → o kareye geçer ve durur (`BURNING` ise yakma kontrolü tetiklenir).
  3. `PIT` ise → çukura düşer ve ölür (`PIECE_FELL_IN_PIT`).
  4. Düşman taş varsa → çarpışma/saldırı tetiklenir (kalkanı yoksa yer ve o karede durur; kalkanlıysa kalkanı kırar ve bir önceki karede durur).
  5. Yine `ICE` ise → kaymaya devam eder.
* **Ölümcül Hamle Önizlemesi:** Bir hamle oyuncunun taşını `PIT`'e kaydırıyorsa veya `BURNING` üzerinde bitiriyorsa, hamle önizlemesinde o karede belirgin bir **uyarı/kafatası ikonu** gösterilir.

### B. Simetrik Savaş Sisi (Symmetric Fog of War)
* **Görüş Durumları:** `UNEXPLORED` (siyah), `EXPLORED` (soluk arazi, taşlar gizli), `VISIBLE` (tam görünür).
* **Varsayılan Görüş Yarıçapları (Chebyshev mesafesi):** Piyon `2`, At `2`, Kale `3`, Fil `3`, Vezir `3`, Şah `3`. (`WATCHTOWER` +2, `SCOUT` +2 ekler.)
* **Simetrik Işın Takibi:** A karesinden B karesine görüş, A→B VEYA B→A çizgisinden en az biri `WALL` tarafından kesilmiyorsa açıktır (ara karelerdeki taşlar görüşü kesmez, sadece `WALL` keser). Bu sayede "ben onu görüyorum ama o beni görmüyor" asimetrisi oluşmaz.
* **Adalet Koruması (2 Katman):**
  1. **Silüet Halkası:** Bir taşın `VISIBLE` menzilinin +2 kare dışındaki (ve duvarla tamamen yalıtılmamış) bölgedeki düşmanlar, `SHADOW_WALKER` değilse kırmızı **`?` silüeti** olarak görünür.
  2. **Uyanma (`AggroState` — Sefer Modu):** Düşmanlar `SLEEPING` başlar. Oyuncunun görüşüne girdiklerinde, hasar aldıklarında veya 2 kare yakınındaki bir müttefik saldırıya uğradığında `ALERTED` olurlar. `ALERTED` düşman o tur hamle yapmaz (sadece `!` ikonu çıkar); bir sonraki düşman turunda `ACTIVE` olur.

### C. Taş Mutasyonları (`TraitId` — Kesin Tanımlar)
Bir taş en fazla **3 trait** taşıyabilir (UI taşmasını önlemek için):
* `SHIELDED` (Zırhlı): Savaş başına 1 kez (`shieldActive: true`) ilk saldırı veya yanma hasarını emer. Saldırı kalkanı kırdığında:
  * Saldıran taş **kayarak/uzaktan** geliyorsa (Kale, Fil, Vezir veya buz kayması) hedefin **bir önceki boş karesinde** durur.
  * Saldıran taş **bitişikten** vuruyorsa veya **At** ise başlangıç karesinde kalır.
* `FROST_TOUCH` (Buz Dokunuşu): Saldırıp öldüremediği (kalkanını kırdığı) hedefi **1 tur dondurur** (`frozenTurns = 1`). Ayrıca hareketini bir düşmanın ortogonal (yukarı/aşağı/sağ/sol) bitişiğinde bitirdiğinde, o bitişik düşmanlardan en yakın/ilkini 1 tur dondurur. (Belirsiz At atlama yolu yerine tüm taşlarda net çalışır.)
* `EXPLOSIVE` (Patlayıcı): Öldüğünde (`PIT`'e düşmediyse) kendi karesini ve ortogonal 4 komşusunu (`WALL` ve `PIT` hariç) 2 turluğuna `BURNING` yapar.
* `SCOUT` (Gözcü): Görüş yarıçapı +2.
* `SHADOW_WALKER` (Gölge): Silüet halkasında `?` bırakmaz, sadece `VISIBLE` alanına girince görünür.
* `PUSHER` (İtici): Hareketini tamamlayınca (saldırı/yeme yapmadıysa) ortogonal bitişiğindeki seçili veya en yakın 1 düşmanı uzaklaşma vektöründe 1 kare iter. İtilen taş `WALL` veya başka taşa çarparsa hareket etmez; `PIT`'e itilirse ölür; `ICE`'a itilirse kayma fiziği tetiklenir! (İtme, `USE_ABILITY` yerine hareket sonrası opsiyonel tek tık hedef seçimi veya doğrudan aktif yetenek olarak çalışır — MVP'de **hareket yerine kullanılan 1 menzilli aktif yetenek** `USE_ABILITY` olarak tanımlanarak tıklama akışı sadeleştirilir.)
* `DASH_ON_REVEAL` (Pusu): Tur başında rakibin `VISIBLE` alanında değilken hamle yapıp görünür hale gelirse, aynı taş o tur **1 ekstra hamle** (`bonusMoves = 1`, tur başına max 1 kez) kazanır.

### D. Fraksiyon / Komutan Pasifleri (`FactionPassive`)
* `FROST_WARDENS`: Buzda kaymazlar.
* `NECROMANCERS`: Ölen düşman taşı karesinde 2 turluk bir `pendingSpawns` işareti bırakır; süre dolduğunda kare boşsa orada 1 düşman Piyonu doğar (üzerinde bir taş duruyorsa doğma iptal olur).
* `SIEGE_ENGINEERS`: Kaleleri `USE_ABILITY` ile ortogonal bitişiğindeki bir `WALL` karesini kırıp `PLAIN` yapabilir (turu harcar).
* `RAIDERS`: Tüm Atları otomatik `DASH_ON_REVEAL` özelliğine sahiptir.

---

## 5. TUR ÇÖZÜMLEME BORU HATTI (KATİ İŞLEM SIRASI)

Her `MOVE` veya `USE_ABILITY` aksiyonu motor içinde **tam olarak şu sırayla** işlenir:
1. **Doğrulama:** Sıra bu tarafta mı? Taş bu tarafa mı ait? `frozenTurns === 0` mı? Hedef geçerli mi?
2. **Birincil Aksiyon:** Taş hedefe taşınır veya yetenek (`PUSHER` itmesi / `SIEGE_ENGINEERS` duvar kırması) uygulanır.
3. **Arazi Fiziği:** `ICE` kayması (varsa zincirleme, max 16 adım) → `PIT` düşme kontrolü → `SHIELDED` kalkan kırma veya taş yeme.
4. **Ölüm ve Temas Tetikleyicileri:**
   * Yenen taş `EXPLOSIVE` ise çevreyi `BURNING` yap.
   * `NECROMANCERS` aktifse ölen düşman karesine 2 turluk spawn işareti koy.
   * Saldıran taş `FROST_TOUCH` ise hedefi/ortogonal düşmanı dondur.
   * Piyon son sıraya ulaştıysa terfi ettir (`PIECE_PROMOTED`).
5. **Kazanma Kontrolü:** Herhangi bir Şah öldüyse `MATCH_ENDED` üret ve boru hattını sonlandır.
6. **Sis, Uyanma ve Pusu Güncellemesi:** İki tarafın sis haritasını yeniden hesapla; Sefer modunda yeni görülen/yakınında çatışma olan `SLEEPING` düşmanları `ALERTED` yap. `DASH_ON_REVEAL` tetiklendiyse `bonusMoves` ver ve sırayı değiştirme.
7. **Tur Sonu Aşaması (Ekstra hamle yoksa):**
   * Aktif tarafın `BURNING` kare üzerinde kalan taşlarına 1 hasar uygula (kalkan kırılır veya taş ölür; tekrar Şah kontrolü yap).
   * Aktif tarafın taşlarının `frozenTurns` sayaçlarını 1 azalt (minimum 0).
   * `BURNING` karelerin `burnTurns` sayaçlarını ve `pendingSpawns` sayaçlarını güncelle (0 olan alev söner, 0 olan boş karede iskelet doğar).
   * Sırayı diğer tarafa geçir (`TURN_CHANGED`). Yeni aktif tarafın `ALERTED` düşmanlarını `ACTIVE` yap.

---

## 6. HARİTA ÜRETİCİ VE ERİŞİLEBİLİRLİK DOĞRULAYICISI

* Haritalar `data/encounters.ts` içindeki yarı-yapılandırılmış şablonlardan (oda boyutu, tema, garantili kule/arazi oranları, düşman havuzu) `seed` ile üretilir.
* **Zorunlu Softlock Doğrulayıcısı (`validateMapConnectivity`):** Üretilen her haritada, `PLAYER` başlangıç bölgesi ile `ENEMY` Şahı arasında `WALL` ve `PIT` dışındaki karelerden en az 1 yürüyüş yolu olduğu BFS ile doğrulanır. Doğrulama geçmezse otomatik olarak orta hattan bir geçit açılır veya yeni seed varyasyonu denenir.

---

## 7. OYUN MODLARI VE DENGE VERİLERİ

### MOD 1: SEFER MODU (1. Perde MVP: 4 Çatışma + 1 Boss)
* **Başlangıç Mangaları:**
  1. *Keşif Mangası:* Şah + 2 At + 2 Piyon (`SCOUT`)
  2. *Kuşatma Birliği:* Şah + 1 Kale (`SHIELDED`) + 1 Fil + 3 Piyon
  3. *Suikastçılar:* Şah + 1 Vezir + 1 Piyon (`SHADOW_WALKER`)
* **Oda İlerlemesi:**
  * Oda 1 (8x8 — Orman Sınırı, pasif yok, hafif duvar/kule)
  * Oda 2 (8x8 — Buzul Geçidi, `FROST_WARDENS`, buz koridorları + çukurlar)
  * Oda 3 (9x8 — Kemik Ovası, `NECROMANCERS`, gölge ve patlayıcı elitler)
  * Oda 4 (9x9 — Kuşatma Duvarı, `SIEGE_ENGINEERS`, yıkılabilir siperler)
  * Oda 5 — **BOSS: Buzul/Kuşatma Komutanı** (9x9, Boss Şah `SHIELDED` + her 3 turda etrafına 1 kare buz/alev halkası + 2 elit koruma).
* **Savaş Sonrası Ödül Ekranı (3 Kart, Seed'li):**
  * *Takviye:* Yeni taş (At, Fil, Kale, Gözcü Piyon).
  * *Mutasyon:* Seçtiğin mevcut bir taşa 1 trait ekle.
  * *Onarım / Diriltme:* Kaybedilen 1 taşı geri getir VEYA tüm orduna sonraki savaş için `SHIELDED` ver.
  * *Pazarlık (Pact — %30 olasılıkla 3. kart):* Güçlü ödül (ör. Vezir veya 2 trait) karşılığı sonraki 2 odada tüm düşman piyonlarına `SHIELDED` veya `EXPLOSIVE` eklenmesi.

### MOD 2: ASİMETRİK ORDU VE GELİŞEN DÜELLO (1v1 Best-of-3)
* **Bütçe:** Ücretsiz 1 Şah + **20 Puan**.
* **Maliyetler:** Piyon `1`, Gözcü Piyon (`SCOUT`) `2`, At `3`, Fil `3`, Kale `5`, Vezir `9`.
* **Gizli Dizilim:** Oyuncu kendi tarafındaki son 2 sıraya (duvar/çukur olmayan karelere) taşlarını dizer. AI da 4 asimetrik şablondan birini (`Ağır Süvari`, `Kale Duvarı`, `Çapraz Pusu`, `Vezir Komandosu`) seçip kendi tarafına gizli dizer.
* **El Arası Draft:** Her el sonunda 3 karttan 1'i seçilir. Önceki eli **kaybeden** taraf "Nadir/Epik" havuzdan (ör. Kale + Trait veya Fraksiyon Pasifi), **kazanan** taraf "Standart" havuzdan seçer.

---

## 8. ADİL YAPAY ZEKA (AI) TASARIMI

* **Hile Yok:** AI yalnızca `getVisibleState(state, 'ENEMY')` üzerinden hamle üretir. Oyuncunun daha önce görüp sisin içine kaçan taşlarını `aiMemory.lastKnownPositions` içinde tutar; görünür hedef yoksa son bilinen konuma veya en yakın `WATCHTOWER`'a yönelir.
* **Sefer Modu AI (`campaignAi.ts`):**
  * Yalnızca `ACTIVE` düşmanlar hamle yapar (`SLEEPING` ve `ALERTED` hareket etmez).
  * Her tur başında görünür aktif düşmanların en yüksek puanlı hedefini hesaplayıp arayüze **Niyet Oku (Intent Preview)** verisi sağlar.
* **Düello AI (`skirmishAi.ts`):**
  * **Iterative Deepening Alpha-Beta Minimax** (derinlik 1 → 2 → 3, sert zaman bütçesi **120ms**). Süre dolunca tamamlanan son derinliğin en iyi hamlesi döner; tarayıcı asla donmaz.
  * Hamle sıralaması (Move Ordering): Önce taş yemeler ve Şah tehditleri incelenir (budama verimliliği için).

---

## 9. GÖRSEL GERİ BİLDİRİM, KONTROLLER VE KLAVYE KISAYOLLARI

* **Olay Oynatıcı (Animation Queue):** `stepGame()`'den dönen `events` dizisi sırayla görsel/ses efektine çevrilir (ör. önce 180ms kayma → sonra kalkan kırılma parçacığı + ekran sarsıntısı + "KALKAN KIRILDI!" yüzen metni + synth ses). Animasyon hızı ayarlardan `1x` / `2x` seçilebilir.
* **Kısayollar:** `Esc` (seçimi iptal et), `Space` (turu pas geç / onayla), `I` (niyet oklarını aç/kapa), `M` (sesi kapat/aç), `Z` (yalnızca Sandbox'ta geri al).
* **Kayıt Sistemi:** Sefer ve Düello durumu her hamle sonunda `localStorage` (`tfc_save_v1`) içine otomatik yazılır. Sürüm uyuşmazlığı veya bozuk JSON durumunda güvenli sıfırlama yapılır.

---

## 10. KLASÖR YAPISI

```text
src/
├── engine/
│   ├── types.ts          # Saf JSON tipleri, GameAction, GameEvent, AppState
│   ├── prng.ts           # mulberry32 deterministik PRNG + FNV-1a stateHash
│   ├── board.ts          # Hareket vektörleri, buz fiziği, harita BFS doğrulayıcısı
│   ├── fog.ts            # Simetrik LOS, 3 seviyeli sis, silüet halkası
│   ├── traits.ts         # Kalkan, donma, patlama, itme, fraksiyon pasifleri
│   ├── reducer.ts        # 7 adımlı boru hattıyla saf stepGame(state, action)
│   └── visibility.ts     # getVisibleState(state, side)
├── ai/
│   ├── campaignAi.ts     # Aggro durumları, hafıza, niyet önizlemesi, sefer botu
│   └── skirmishAi.ts     # 120ms bütçeli Iterative Deepening Alpha-Beta + ordu kurucu
├── data/
│   ├── squads.ts         # 3 başlangıç mangası ve birim maliyetleri
│   ├── encounters.ts     # 1. Perde (4 oda + 1 Boss) ve Düello harita şablonları
│   ├── rewards.ts        # Ödül havuzu, nadirlikler ve Pazarlık kartları
│   └── factions.ts       # 4 fraksiyon pasifi tanımları
├── render/
│   ├── canvasRenderer.ts # Katmanlı HiDPI Canvas çizimi + ölümcül hamle önizlemesi
│   ├── sprites.ts        # Vektörel satranç taşları, arazi dokuları ve trait rozetleri
│   └── fxQueue.ts        # GameEvent -> tween, parçacık, screen shake, floating text
├── audio/
│   └── synthSfx.ts       # Web Audio API prosedürel ses sentezleyici
├── storage/
│   └── persistence.ts    # Versiyonlu localStorage kayıt/yükleme + Günlük Seed
├── ui/
│   └── uiController.ts   # Menüler, Ordu Kurucu, Ödül/Draft ekranı, İnceleme Paneli
└── main.ts
tests/
├── board.test.ts         # Hareket, buz kayma zinciri, çukur, BFS harita doğrulama
├── fog.test.ts           # Simetrik LOS, kule bonusu, silüet, SHADOW_WALKER
├── traits.test.ts        # Kalkan sekmesi, donma, patlama, itme->buz kombosu, nekromanser
├── reducer.test.ts       # 7 adımlı boru hattı, deterministik replay + stateHash testi
└── ai.test.ts            # Siste hile yapmama testi, 120ms zaman bütçesi testi
```

---

## 11. FAZ FAZ KODLAMA PLANI (KATI İŞ AKIŞI)

Her fazın sonunda şu 3 adımı tamamlamadan sonraki faza geçme:
1. O fazın birim testlerini yaz ve `npm test` ile tamamının geçtiğini doğrula.
2. `npm run build` ile sıfır TypeScript/derleme hatası olduğunu doğrula.
3. Yapılanları en fazla 5 maddede özetle ve **sonraki faz için benden onay iste**.

* **FAZ 1 — İskelet, Deterministik Çekirdek ve Arazi Fiziği:**
  Vite + TS (`strict`) + Vitest kurulumu. `types.ts`, `prng.ts` (`mulberry32` + `computeStateHash`), `board.ts` (tüm taş hareketleri, piyon terfisi, `WALL`/`PIT`/`ICE` kayma zinciri, `validateMapConnectivity`). `board.test.ts` yaz ve doğrula.
* **FAZ 2 — Simetrik Savaş Sisi, Mutasyonlar ve Olay Üreten Reducer:**
  `fog.ts`, `traits.ts`, `visibility.ts`, `reducer.ts` (7 adımlı tam boru hattı + `GameEvent[]` çıktısı + `actionHistory`). `fog.test.ts`, `traits.test.ts` ve deterministik tekrar oynatma (`reducer.test.ts`) testlerini yaz ve doğrula.
* **FAZ 3 — HiDPI Canvas Renderer, Olay Animasyonları, Ses ve Sandbox:**
  `sprites.ts`, `canvasRenderer.ts` (3 seviyeli sis, silüetler, buz rota çizgisi, ölümcül hamle uyarısı, Pointer Events), `fxQueue.ts`, `synthSfx.ts`. İki tarafın da manuel oynanabildiği, sis açısının değiştirilebildiği ve `Undo` yapılabilen oynanabilir Sandbox ekranı.
* **FAZ 4 — Adil Yapay Zeka ve Fraksiyon Pasifleri:**
  4 fraksiyon pasifi, `campaignAi.ts` (uyuma/uyanma + niyet okları + son bilinen konum hafızası) ve `skirmishAi.ts` (120ms bütçeli Iterative Deepening Alpha-Beta). `ai.test.ts` ile hız ve adil görüş doğrulaması.
* **FAZ 5 — Mod 1: Sefer Modu (1. Perde Tam Döngü):**
  Ana menü, 3 başlangıç mangası, 4 çatışma + 1 Boss (`encounters.ts`), savaş sonrası 3'lü ödül/mutasyon/pazarlık ekranı (`rewards.ts`), permadeath ve zafer ekranları.
* **FAZ 6 — Mod 2: Asimetrik Ordu ve Gelişen Düello (Best-of-3):**
  20 puanlık bütçeli ordu kurma ve gizli dizilim ekranı, AI asimetrik ordu şablonları, el sonu geri dönüş dengeli draft ekranı.
* **FAZ 7 — Kalıcılık, Günlük Seed ve Cila:**
  Versiyonlu `localStorage` otomatik kayıt/devam et, Günlük Seed (`YYYY-MM-DD`) ve özel seed girişi, klavye kısayolları, `1x/2x` hız ayarı ve responsive yerleşim kontrolü.

---
