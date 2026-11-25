# Security Policy (Güvenlik Politikası)

## Desteklenen Sürümler (Supported Versions)

S.U.C.S. tamamen tarayıcı içi, çevrimdışı öncelikli bir statik web uygulamasıdır. Güvenlik güncellemeleri aşağıdaki sürümler için sağlanır:

| Sürüm | Destek Durumu |
| :--- | :--- |
| `0.2.x` (`main`) | ✅ Destekleniyor |
| `< 0.2.0` | ❌ Desteklenmiyor |

---

## Güvenlik Açığı Bildirme (Reporting a Vulnerability)

**Lütfen güvenlik açıklarını herkese açık Issue olarak paylaşmayın.**

Bunun yerine GitHub'ın özel güvenlik bildirimi kanalını kullanın:

👉 **[Özel Güvenlik Bildirimi Oluştur (GitHub Security Advisories)](https://github.com/VelliDR/stress-under-chess-sim/security/advisories/new)**

Bildiriminizde mümkünse şu bilgileri paylaşın:
- Etkilenen bileşen veya dosya yolu (ör. `localStorage` JSON içe aktarım ayrıştırıcısı, DOM `innerHTML` kullanımı, Web Worker mesajları veya derleme bağımlılığı)
- Yeniden üretme adımları (PoC / örnek JSON veya girdi)
- Beklenen etki ve olası çözüm önerisi

### Yanıt Süreci
- **İlk geri dönüş:** En geç **72 saat** içinde alındı onayı.
- **Değerlendirme ve yama:** Doğrulanan açıklar için öncelikli düzeltme geliştirilir ve düzeltme yayınlandıktan sonra koordineli olarak duyurulur.

---

## Güvenlik Kapsamı

S.U.C.S. sunucu tarafında kullanıcı verisi toplamaz veya saklamaz; ancak aşağıdaki istemci tarafı yüzeyler güvenlik kapsamına girer:
- `Sistem → Kayıt İçe Aktar (JSON)` akışında bozuk/kötü niyetli kayıt verilerinin güvenli ayrıştırılması ve XSS koruması
- `localStorage` (`sucs_save_v1`, `sucs_ui_prefs_v1`) şema doğrulaması
- GitHub Pages dağıtımı ve `package-lock.json` / geliştirme bağımlılıkları
- Web Worker (`sucsAiWorker.ts`) ve Savaş Sisi (`VisibleState`) bilgi sızıntısı / hile sınırları
