# Accessibility Statement (Erişilebilirlik Politikası)

**S.U.C.S. — Stress Under Chess Simulator**, farklı fiziksel, görsel ve duyusal ihtiyaçlara sahip oyuncuların taktiksel satranç deneyimine rahatça erişebilmesini hedefler.

---

## Mevcut Erişilebilirlik Özellikleri

### 1. Hareket ve Görsel Hassasiyet (**Sakin Ekran / Calm Screen**)
- **Sistem → Sakin Ekran** anahtarı etkinleştirildiğinde ekran sarsıntısı (screen shake) `%80` azaltılır, tam ekran flaşlar ve CRT glitch kaymaları kapatılır.
- **CRT Tarama Çizgileri** ayarı `Kapalı / Hafif / Retro` arasında isteğe göre kapatılabilir.
- Tüm bildirim ve geçişler kontrollü adımlı (stepped) animasyonlar kullanır.

### 2. Renk Körlüğü ve Görsel Okunabilirlik
- Tüm zemin tipleri (`WALL`, `PIT`, `ICE`, `WATCHTOWER`, `BURNING`, `CRACKED`, `MIASMA`) ve tuzaklar yalnızca renkle değil **ayırt edici geometrik piksel desenleri** ve ikonlarla ayrılır.
- Tehlikeli/ölümcül hamleler kafatası işareti ile ayrıca belirtilir (`Ölümcül Uyarı` ayarı açıktır).
- Yüksek kontrastlı koyu zemin üzerinde Türkçe (`Ç, Ğ, İ, Ö, Ş, Ü`) tam destekli piksel tipografi (`Pixelify Sans`) ve sert metin gölgeleri kullanılır.

### 3. Klavye ve Tek-Girdi (Fare / Dokunmatik) Desteği
- Tüm etkileşimler **Pointer Events** ile çalışır; dokunmatik cihazlarda inceleme kartı hover gerektirmeden tek dokunuşla açılır ve kapatılabilir.
- Tam klavye kısayol desteği:
  - `Tab`: Sıradaki oynanabilir taşı seçer
  - `Space`: Turu pas geçer / maç sonu ilerler
  - `Esc`: Seçimi, açık çekmeceleri veya modalları kapatır / oyunu duraklatır
  - `F`: Tam ekranı açar / kapatır
  - `L`: Olay günlüğü ve kısayol çekmecesini açar / kapatır
  - `T` / `I`: Tehdit alanı ve düşman niyet oklarını açar / kapatır
  - `H`: Saha Rehberi (Codex) modalını açar
  - `M`: Sesi açar / kapatır
  - `Z`: Kaos Laboratuvarı (Sandbox) modunda hamleyi geri alır
- Modallar `role="dialog"` ve `aria-modal="true"` öznitelikleriyle işaretlenir; butonlarda görünür `:focus-visible` odak çerçevesi bulunur.

### 4. Ses ve İçerik Tercihleri
- Ses efektleri tek tuşla (`M`) susturulabilir veya Sistem panelinden `%0–100` arasında ayarlanabilir; hiçbir kritik oynanış bilgisi yalnızca sese bağlı değildir.
- **Çift Tonlu Anlatı:** Sistem ayarlarından **Efendi Mod** seçilerek argo/sert taş replikleri tamamen yumuşak tona geçirilebilir.

---

## Bilinen Kısıtlar (Known Limitations)

- Oyun tahtası HTML5 `<canvas>` üzerinde çizildiği için ekran okuyucular (NVDA, VoiceOver, Orca) şu an tahta karelerini ve taş konumlarını doğrudan okuyamamaktadır.
- Klavye ile kareler arası yön tuşlarıyla (`ArrowUp/Down/Left/Right`) doğrudan imleç gezdirme henüz eklenmemiştir (`Tab` ile taşlar arası geçiş desteklenir).

---

## Erişilebilirlik Engeli Bildirme

Oyunu oynarken karşılaştığınız bir erişilebilirlik engeli veya iyileştirme önerisi için lütfen **Issue** açarak bildirin:

👉 **[Erişilebilirlik / Hata Bildirimi Aç](https://github.com/VelliDR/stress-under-chess-sim/issues/new/choose)**
