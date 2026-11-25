# TEKNİK ŞARTNAME EKİ: SUNUCUSUZ QR + WEBRTC 2 OYUNCULU MODÜL (`MULTIPLAYER_SPEC.md`)

Bu doküman, `DESIGN.md v2` mimarisinin (saf JSON `GameState`, `stepGame(state, action)`, `mulberry32` PRNG ve FNV-1a `computeStateHash`) üzerine **sıfır sunucu (zero-server)** ilkesiyle 2 oyunculu **Gelişen Düello (1v1 Skirmish Best-of-3)** modunu ekler.

**Temel Kural:** `src/engine/` altındaki çekirdek oyun kuralları bu modül için değiştirilmeyecek; tüm ağ, sıkıştırma, kamera ve senkronizasyon mantığı izole `src/net/` katmanında yaşayacaktır.

---

## 1. AĞ MİMARİSİ VE ROL DAĞILIMI (DETERMİNİSTİK LOCKSTEP)

* **Model:** Eşler arası (P2P) **Deterministic Lockstep**. İki tarayıcıda da aynı `matchSeed` ile aynı oyun motoru koşar; ağ üzerinden ağır tahta durumları değil, yalnızca küçük `GameAction` paketleri ve doğrulama özetleri (`stateHash`) gönderilir.
* **Roller:**
  * **Kurucu (`HOST`):** Oyun içinde `side = 'PLAYER'` rolünü alır, `matchSeed` değerini üretir ve Desync durumunda anlık kurtarma snapshot'ının kaynağıdır.
  * **Katılımcı (`GUEST`):** Oyun içinde `side = 'ENEMY'` rolünü alır.
* **Kanonic Koordinatlar ve `flipBoard` Görünümü:**
  * Motor koordinatları her iki cihazda da birebir aynıdır (`PLAYER` alt sırada, `ENEMY` üst sırada).
  * `GUEST` cihazında `canvasRenderer.ts` ve Pointer hit-test katmanı `flipBoard = true` parametresiyle çalışır: ekrana çizerken `(x, y)` → `(width - 1 - x, height - 1 - y)` olarak ters çevrilir; tıklama okunurken tekrar kanonik `(x, y)` koordinatına dönüştürülür. Böylece her iki oyuncu da kendi ordusunu ekranın altında görür.

---

## 2. SUNUCUSUZ QR + WEBRTC EL SIKIŞMA (SIGNALING)

Merkezi bir signaling sunucusu olmadan iki tarayıcıyı bağlamak için **2 Adımlı QR El Sıkışma** kullanılır:

### Akış
1. **Host "Oda Kur" der:** `RTCPeerConnection` oluşturur, güvenilir ve sıralı bir `RTCDataChannel('tfc-sync', { ordered: true })` açar, `createOffer()` çağırır ve ICE adaylarının toplanmasını bekler (Non-Trickle ICE). Toplanan veriyi sıkıştırıp **Teklif QR Kodu (`O:...`)** olarak ekrana basar.
2. **Guest "Odaya Katıl" der:** Kamerayla Host'un QR kodunu okur (veya metin yapıştırır). Teklifi çözer, `setRemoteDescription` + `createAnswer()` çağırır, ICE toplar ve ekrana **Yanıt QR Kodu (`A:...`)** basar.
3. **Host Yanıtı Okur:** Guest'in QR kodunu okur, `setRemoteDescription` uygular. DataChannel `open` olayını tetikler ve iki cihaz doğrudan bağlanır.

### Kritik Mühendislik: SDP Minifikasyonu ve Sıkıştırma (QR Okunabilirliği)
Ham WebRTC SDP metni 1.800–3.500 bayt arasındadır ve kamera ile okunması çok zor yoğun QR kodları üretir. Bu nedenle QR'a ham SDP **kesinlikle basılmayacaktır**.

1. **ICE Toplama Zaman Aşımı:** `iceGatheringState === 'complete'` beklenir; ancak takılmayı önlemek için **en fazla 2.500 ms** sert zaman aşımı uygulanır (süre dolduğunda o ana kadar toplanan adaylarla devam edilir).
2. **Aday Filtreleme:** Yalnızca `udp` protokolündeki en fazla **3 ICE adayı** seçilir (öncelik: `srflx` IPv4, ardından `host` IPv4; gereksiz TCP ve tekrarlı adaylar atılır).
3. **Minimal SDP Tuple Şeması (`CompactSignal`):**
   ```ts
   // Ham SDP'den ayıklanan ve karşı tarafta standart DataChannel SDP'sine geri örülen minimum veri
   export interface CompactSignal {
     v: 1;                      // Protokol sürümü
     t: 'o' | 'a';              // offer | answer
     u: string;                 // ice-ufrag
     p: string;                 // ice-pwd
     f: string;                 // sha-256 fingerprint (iki noktasız hex)
     c: Array<[string, number, 'h' | 's']>; // [ip, port, host|srflx]
   }
   ```
4. **Sıkıştırma Boru Hattı:** `JSON.stringify(signal)` → `CompressionStream('deflate-raw')` → `Base64URL` → Prefix (`TFC1:`).
   * *Hedef Boyut:* ~180–340 karakter (QR Sürüm 9–12, Hata Düzeltme Seviyesi `L`). Düşük ışıkta bile saniyeler içinde okunur.
   * `CompressionStream` desteklemeyen eski tarayıcılarda sıkıştırmasız Base64URL (`TFC0:`) geri dönüşü (fallback) sağlanır.

### Ağ ve NAT Gerçekçiliği
* **Çevrimdışı Aynı Ağ (Wi-Fi / Mobil Hotspot):** `iceServers: []` ile internete bile ihtiyaç duymadan doğrudan LAN üzerinden bağlanır.
* **Farklı Ağlar (Online Mod):** Varsayılan `iceServers` listesinde yalnızca hafif kamusal STUN sunucuları (ör. `stun:stun.l.google.com:19302`) bulunur (Ayarlar'dan "Yalnızca Yerel Ağ / Çevrimdışı" seçeneğiyle kapatılabilir).
* **Simetrik NAT Uyarısı ve Metin Fallback:** Bazı mobil operatörlerin Simetrik NAT kuralları TURN sunucusu olmadan P2P bağlantıyı engelleyebilir. Bağlantı 8 saniye içinde `connected` olmazsa kullanıcıya net Türkçe yönlendirme gösterilir (*"Mobil ağ kısıtlaması algılandı: İki cihazı aynı Wi-Fi ağına veya birinin mobil erişim noktasına bağlayıp tekrar deneyin"*). Ayrıca kamera izni olmayan/bozuk cihazlar için her QR ekranında **"Kodu Kopyala / Yapıştır"** düğmesi bulunur.

---

## 3. VERİ KANALI PROTOKOLÜ (`WireMessage`)

DataChannel üzerinden yalnızca şu tipli JSON mesajları akar:

```ts
export type WireMessage =
  | { type: 'HELLO'; protocolVersion: 1; matchId: string; matchSeed: number; hostSide: 'PLAYER' }
  | { type: 'HELLO_ACK'; matchId: string; guestReady: true }
  // Gizli dizilim ve el arası draft için Commit-Reveal
  | { type: 'PHASE_COMMIT'; round: number; phase: 'DEPLOY' | 'DRAFT'; commitHash: string }
  | { type: 'PHASE_REVEAL'; round: number; phase: 'DEPLOY' | 'DRAFT'; payload: unknown; nonce: string }
  // Savaş içi kilitli adım (Lockstep) aksiyonları
  | { type: 'ACTION_SYNC'; seq: number; action: GameAction; stateHash: string }
  | { type: 'ACTION_ACK'; seq: number; stateHash: string }
  // Bağlantı sağlığı ve Desync kurtarma
  | { type: 'PING'; ts: number }
  | { type: 'PONG'; ts: number }
  | { type: 'DESYNC_ALERT'; seq: number; localHash: string; remoteHash: string }
  | { type: 'RESYNC_SNAPSHOT'; seq: number; fullState: GameState; stateHash: string }
  // Maç sonu
  | { type: 'REMATCH_REQUEST'; newSeed: number }
  | { type: 'REMATCH_ACCEPT' };
```

---

## 4. GİZLİ DİZİLİM VE DRAFT İÇİN COMMIT-REVEAL PROTOKOLÜ

`SKIRMISH_DEPLOY` (20 puanlık ordu kurma) ve `SKIRMISH_DRAFT` (el arası kart seçimi) aşamalarında iki oyuncu **eşzamanlı** seçim yapar. Bir oyuncunun karşı tarafın paketini dinleyip ona göre karşı ordu dizmesini önlemek için Web Crypto API tabanlı Commit-Reveal uygulanır:

1. **Yerel Hazırlık:** Her iki oyuncu kendi ekranında ordusunu kurup gizli dizilimini bitirir (`payload = DeploymentPlan`).
2. **Taahhüt (`PHASE_COMMIT`):** Tarayıcı 128-bit kriptografik rastgele `nonce` üretir (`crypto.getRandomValues`) ve `SHA-256(canonicalJSON(payload) + ':' + nonce)` özetini hesaplayıp rakibe gönderir.
3. **Kilit ve Açılış (`PHASE_REVEAL`):** Her iki taraftan da `PHASE_COMMIT` alındıktan sonra, her iki cihaz da gerçek `payload` ve `nonce` değerini otomatik gönderir.
4. **Doğrulama ve Kanonik Uygulama:**
   * Alıcı taraf `SHA-256(canonicalJSON(remotePayload) + ':' + remoteNonce) === savedRemoteCommitHash` kontrolünü yapar (uyuşmazlıkta hile/bozulma hatasıyla maç durdurulur).
   * Doğrulanan her iki tarafın hamleleri, her iki cihazda da **kanonik sırada (önce `PLAYER`, sonra `ENEMY`)** `stepGame()` motoruna verilir. Böylece iki cihazda da birebir aynı `stateHash` ile `BATTLE` başlar.

---

## 5. SENKRONİZASYON, DOĞRULAMA VE DESYNC KURTARMA

### Hamle Akışı (`BATTLE` Fazı)
1. Sırası gelen oyuncu (ör. Host) yerel olarak `stepGame(state, action)` çalıştırır. `error` yoksa:
   * `seq = state.actionHistory.length`
   * `stateHash = computeStateHash(nextState)`
   * `ACTION_SYNC` paketini DataChannel'dan yollar ve kendi ekranında animasyonları (`events`) oynatır.
2. Alıcı taraf (Guest) `ACTION_SYNC` paketini alır:
   * **Sıra ve Yetki Kontrolü:** `seq` tam olarak beklenen bir sonraki numara mı? `action` gerçekten rakibin kontrolündeki `side` için geçerli mi? (Geçersizse paketi reddeder.)
   * **Yerel Motor Doğrulaması:** Kendi yerel state'i üzerinde `stepGame(localState, msg.action)` çalıştırır.
   * **Hash Karşılaştırması:** `computeStateHash(localNextState)` ile `msg.stateHash` karşılaştırılır:
     * **Eşleşiyorsa:** `ACTION_ACK` döner, animasyon kuyruğunu oynatır ve sırayı açar.
     * **Eşleşmiyorsa (Desync):** `DESYNC_ALERT` gönderir, girdi kilitlenir. Host otomatik olarak `RESYNC_SNAPSHOT` yollar; Guest state'i geri yükleyip hash doğrulayarak oyuna kesintisiz devam eder.

### Bağlantı Kopması ve Yeniden Bağlanma (Reconnect)
* **Heartbeat:** Her 3 saniyede `PING`/`PONG`. 10 saniye yanıt gelmezse "Bağlantı Koptu — Yeniden Bağlan" penceresi açılır.
* **Kaldığı Yerden Devam:** Maç durumu her `seq` adımında `localStorage` (`tfc_mp_active_v1`) içine kaydedilir. Taraflar yeniden QR el sıkıştığında, `HELLO` içinde aynı `matchId` eşleşirse sıfırdan başlamak yerine son `seq` ve `RESYNC_SNAPSHOT` ile tam kalınan turdan devam edilir.

---

## 6. QR ÜRETİMİ VE KAMERA OKUMA KATMANI (`src/net/qr.ts`)

* **QR Üretici (Çizim):** Sıfır ağır bağımlılık için hafif saf TypeScript QR kod üreticisi (ör. `qrcode-generator` paketi veya minimal yerel SVG/Canvas QR çizici) ile doğrudan yüksek kontrastlı **siyah-beyaz SVG** (beyaz sessiz bölge / quiet zone en az 4 modül) üretilir. Koyu tema içinde QR kodu her zaman **beyaz kart** üzerinde gösterilir (ters renkli QR kameralarda okunmaz).
* **QR Okuyucu (Tarama):**
  1. Önce tarayıcının yerel donanım hızlandırmalı **`BarcodeDetector` API**'si (`formats: ['qr_code']`) kontrol edilir.
  2. Desteklemeyen tarayıcılarda (Firefox / eski Safari) hafif istemci tarafı **`jsQR`** (Canvas kare örnekleme, saniyede 6–8 kare throttle) otomatik devreye girer.
  3. Kamera açılırken `facingMode: { ideal: 'environment' }` (arka kamera) istenir. Kamera izni reddedilirse veya cihazda kamera yoksa arayüz çökmez; doğrudan **"Metin Kodu Yapıştır"** girişine odaklanır.
  4. Okuma başarılı olduğu an tüm `MediaStreamTrack` akışları `track.stop()` ile derhal kapatılır (kamera ışığı açık kalmaz).

---

## 7. KLASÖR YAPISI EKLENTİSİ

```text
src/
├── net/
│   ├── protocol.ts        # WireMessage tipleri, canonicalJSON, SHA-256 Commit-Reveal
│   ├── sdpCodec.ts        # SDP minifikasyonu, geri örme, deflate-raw + Base64URL
│   ├── rtcTransport.ts    # RTCPeerConnection, DataChannel, ICE timeout, PING/PONG
│   ├── qrCodec.ts         # SVG QR üretimi + BarcodeDetector / jsQR kamera okuyucu
│   └── mpSession.ts       # Lockstep yöneticisi (ACTION_SYNC, stateHash, Desync/Reconnect)
├── ui/
│   └── mpLobbyModal.ts    # Oda Kur / Katıl, QR göster-tara, kopyala-yapıştır, bağlantı durumu
tests/
├── sdpCodec.test.ts       # Ham SDP -> CompactSignal -> Sıkıştır -> Çöz -> Geçerli SDP testi
├── protocol.test.ts       # Commit-Reveal doğrulama ve hileli payload reddetme testi
└── mpSession.test.ts      # MockTransport ile tam 2 oyunculu maç + kasıtlı Desync kurtarma testi
```

---

## 8. UYGULAMA FAZLARI (DESIGN.md v2 DEVAMI)

`DESIGN.md v2` içindeki ilk 7 faz tamamlandıktan sonra aynı katı test-onay disipliniyle uygulanır:

* **FAZ 8 — Protokol, SDP Sıkıştırıcı ve Sanal 2 Oyunculu Senkron Testi:**
  `protocol.ts`, `sdpCodec.ts` ve `mpSession.ts` (taşıyıcı arayüzünden soyutlanmış `ITransport` ile) yazılır. Bellek içi `MockTransport` kullanan `mpSession.test.ts` ile iki ayrı `GameState` örneğinin Commit-Reveal dizilim yapıp tam bir maç oynadığı, her hamlede `stateHash` değerlerinin eşleştiği ve yapay bir Desync enjekte edildiğinde `RESYNC_SNAPSHOT` ile toparlandığı doğrulanır.
* **FAZ 9 — WebRTC Transport, QR Kod Arayüzü ve `flipBoard` Entegrasyonu:**
  `rtcTransport.ts`, `qrCodec.ts`, `mpLobbyModal.ts` ve `canvasRenderer.ts` içine `flipBoard` görünüm dönüşümü eklenir. Ana menüye **"2 Oyunculu (QR Eşleşme)"** seçeneği bağlanır. Tek cihazda iki ayrı tarayıcı sekmesi arasında kopyala/yapıştır ve iki telefon arasında kamera QR okutma testiyle doğrulanır.

---

**Not (AI Ajanına):** Bu modülü kodlarken `src/engine/` dizininde hiçbir değişiklik yapma. Eğer motorun bir bilgiye erişimi eksik görünürse önce gerekçesini açıklayıp benden onay iste.
