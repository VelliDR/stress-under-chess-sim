// src/data/narrative.ts
// S.U.C.S. — Stress Under Chess Simulator
// Saf, %100 deterministik (Math.random() içermez) çift tonlu terminal diyalog motoru.

export type NarrativeTone = 'unfiltered' | 'polite';

export type NarrativePieceType =
  | 'PAWN'
  | 'KNIGHT'
  | 'BISHOP'
  | 'ROOK'
  | 'QUEEN'
  | 'KING'
  | 'OCAKLI'
  | 'MECZUP'
  | 'GULYABANI';

export type PieceQuoteTrigger =
  | 'DISOBEY'
  | 'MIASMA_CHOKE'
  | 'BREAKDOWN'
  | 'DRIFT'
  | 'DEATH'
  | 'KILL'
  | 'OCAKLI_ULTIMATE'
  | 'MECZUP_ULTIMATE'
  | 'CINNET_CHAIN'
  | 'SILENCED'
  | 'GULYABANI_EVOLVED';

export type DefeatReason = 'KING_CAPTURED' | 'PIT' | 'MIASMA' | 'TRAP' | 'SPEEDRUN';

export type LivePatchId =
  | 'PATCH_204_MIASMA'
  | 'PATCH_01_PANIC'
  | 'PATCH_02_CRACKED'
  | 'PATCH_03_RESET'
  | 'GENERIC';

export interface DualQuotePool {
  readonly unfiltered: readonly string[];
  readonly polite: readonly string[];
}

export interface NarrativePieceRef {
  readonly id: string;
  readonly type: NarrativePieceType;
  readonly side?: 'PLAYER' | 'ENEMY';
}

/**
 * reducer.ts'ten dönen GameEvent nesneleriyle yapısal olarak uyumludur.
 * Eksik veya ek alanlar tip hatası üretmez.
 */
export interface NarrativeEventLike {
  readonly type: string;
  readonly pieceId?: string;
  readonly attackerId?: string;
  readonly victimId?: string;
  readonly ocakliId?: string;
  readonly meczupId?: string;
  readonly gulyabaniId?: string;
  readonly silencedEnemyIds?: readonly string[];
  readonly at?: { readonly x: number; readonly y: number };
}

export interface NarrativeContext {
  readonly seed: number;
  readonly turnNumber: number;
  readonly tone: NarrativeTone;
  /** Hamle öncesi ve sonrası bilinen taşların id -> taş eşlemesi (ölen taşları bulmak için) */
  readonly piecesById: Readonly<Record<string, NarrativePieceRef>>;
}

export interface TerminalLogEntry {
  readonly speaker: string;
  readonly text: string;
  readonly severity: 'info' | 'warn' | 'panic' | 'ultimate' | 'system';
  readonly eventType: string;
}

/* ============================================================================
 * 1. DETERMINİSTİK SEÇİCİ (FNV-1a 32-bit — Sıfır Math.random)
 * ========================================================================== */

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function pickFromPool(pool: DualQuotePool, tone: NarrativeTone, key: string): string {
  const list = tone === 'unfiltered' ? pool.unfiltered : pool.polite;
  if (list.length === 0) return '';
  const idx = fnv1a32(key) % list.length;
  return list[idx] ?? list[0] ?? '';
}

export const PIECE_LABELS_TR: Readonly<Record<NarrativePieceType, string>> = {
  PAWN: 'PİYON',
  KNIGHT: 'AT',
  BISHOP: 'FİL',
  ROOK: 'KALE',
  QUEEN: 'VEZİR',
  KING: 'ŞAH',
  OCAKLI: 'OCAKLI',
  MECZUP: 'MECZUP',
  GULYABANI: 'GULYABANİ',
};

function formatSpeaker(piece: NarrativePieceRef): string {
  const label = PIECE_LABELS_TR[piece.type];
  const suffix = piece.id.slice(-2).toUpperCase();
  return `${label}-${suffix}`;
}

/* ============================================================================
 * 2. TAŞ REPLİK HAVUZU (FİLTRESİZ S.U.C.S. MODU vs. EFENDİ MOD)
 * ========================================================================== */

export const PIECE_QUOTES: Readonly<
  Record<NarrativePieceType, Readonly<Partial<Record<PieceQuoteTrigger, DualQuotePool>>>>
> = {
  PAWN: {
    DISOBEY: {
      unfiltered: [
        'Siktir git kendin yürü oraya, ben 1 puanlık amele miyim?',
        'Vezir namluyu doğrultmuş bekliyor, kör müsün birader?',
        'Şah götünü arka sırada ısıtsın, ben ölüme yürüyeyim. Yok öyle yağma.',
        'Farenin üstünde elin titriyor, bana mı güveniyorsun? Gitmem.',
      ],
      polite: [
        'Ben sadece 1 puanlık bütçeydim, o kareye basmam.',
        'Vezir bana bakıyor. Tek adım bile atmam.',
        'Öne sürülmekten yoruldum, biraz da Şah gelsin.',
        'Elin titriyor, bana hiç güven vermiyorsun.',
      ],
    },
    MIASMA_CHOKE: {
      unfiltered: [
        'Öhö— lan bu sis değil bildiğin hardal gazı amına koyayım!',
        'Ciğerim ağzımdan çıktı, bir kare daha itersen burada kusarım.',
      ],
      polite: [
        'Öhö— bu normal sis değil!',
        'Ciğerlerim 16-bit, bu havaya dayanamıyor...',
      ],
    },
    BREAKDOWN: {
      unfiltered: [
        'İleri, ileri, hep ileri... sikerim terfisini, oturdum aşağı!',
        'Üstüme tıklayıp durma, elim ayağım boşaldı!',
      ],
      polite: [
        'Sadece ileri, hep ileri... nereye kadar?!',
        'Kareler üstüme geliyor, kımıldayamıyorum!',
      ],
    },
    DEATH: {
      unfiltered: [
        'Senin yapacağın açılışın ta amına koyayım.',
        '1 puan için sattın beni, şerefsiz.',
        'Öldüm de senden kurtuldum, oh be.',
        'Umarım iki tur sonra mat olursun.',
      ],
      polite: [
        'En azından terfi stresinden kurtuldum.',
        'Bütçeden 1 puan eksildi. İyi günler.',
        'Bu taktik gerçekten S.U.C.S.',
      ],
    },
    KILL: {
      unfiltered: ['1 puanlık adamdan dayak yedin, utan lan!', 'Al sana piyon tokadı.'],
      polite: ['1 puanlık bütçeyle işi bitirdik.', 'Küçümsemeyecektin.'],
    },
  },

  KNIGHT: {
    DISOBEY: {
      unfiltered: [
        'Oraya atlarsam anamı bellerler, kımıldamıyorum.',
        'L çizip direkt mezara mı gireyim, başka kapıya.',
      ],
      polite: [
        'L çizmek kolay da oradan sağ çıkamam.',
        'Dizginlerim titriyor, o kareye atlamıyorum.',
      ],
    },
    BREAKDOWN: {
      unfiltered: [
        'İki ileri bir... sikeyim, hangi tarafa dönüyorduk?!',
        'Atın bile aklı gitti, sen hâlâ tıklıyorsun.',
      ],
      polite: [
        'Duvar mıydı o, çukur muydu? İki ileri bir... dur.',
        'Nallarım buz tuttu, kımıldayamam.',
      ],
    },
    DEATH: {
      unfiltered: [
        'Körlemesine zıplattın, bok yoluna gittik.',
        'Nalım kırıldı, şerefin de kırılsın.',
        'İçeride pusu varmış, sağ ol ya çok yardımcı oldun.',
      ],
      polite: [
        'Atladım ama yanlış yere...',
        'Süvari düştü, sis kazandı.',
        'Kör sıçrayışın bedeli.',
      ],
    },
    KILL: {
      unfiltered: ['Tependen indim, neye uğradığını şaşırdın!', 'Duvarın arkası güvenli sanıyordun değil mi?'],
      polite: ['Kör noktadan indik.', 'Duvarlar beni durdurmaz.'],
    },
  },

  BISHOP: {
    DRIFT: {
      unfiltered: [
        'Gözüm kaydı, 45 derece kırdım — tutarsa dua et.',
        'Düz çaprazı sikeyim, duvarın arkasından vuruyorum!',
        'Kafam dumanlı, rota şaştı ama fena saplayabilirim.',
      ],
      polite: [
        'Çaprazlar artık düz görünmüyor...',
        '45 derece sapma — ama işine yarayabilir.',
        'Tahta yamuldu, ben değil!',
      ],
    },
    DISOBEY: {
      unfiltered: [
        'O karede zebani bekliyor, tövbe basmam.',
        'Ben din adamıyım, canlı bomba değil.',
      ],
      polite: [
        'Siyah kareler bana fısıldıyor, oraya basmam.',
        'Bu açıdan sadece ölüm görünüyor.',
      ],
    },
    BREAKDOWN: {
      unfiltered: ['Hangi renk karedeydim lan ben?! Başım dönüyor!'],
      polite: ['Çizgiler birbirine karıştı, durmam gerek...'],
    },
    DEATH: {
      unfiltered: [
        'Siyah karede doğduk, bok çukurunda öldük.',
        'Allah belanı versin, beni orada niye unuttun?',
      ],
      polite: ['Son duam çapraz gitti.', 'Kör noktadan yedik...'],
    },
  },

  ROOK: {
    DRIFT: {
      unfiltered: [
        'Fren patladı amına koyayım, sağa kırıyorum!',
        'Taştan kuleyim ama sinirden yamuldum, açılın!',
      ],
      polite: [
        'Frenler tutmuyor, sağa kırıyorum!',
        'Düz hat bitti, duvarın arkasına savruldum!',
      ],
    },
    DISOBEY: {
      unfiltered: [
        'Koca kale çıplak ortaya sürülür mü gerizekalı?',
        'Zırhım var diye her boka süremezsin beni.',
      ],
      polite: [
        'Taştanım ama intihara programlı değilim.',
        'Zırhım bile orada durmaz.',
      ],
    },
    BREAKDOWN: {
      unfiltered: ['Temelim çatladı, yerimden milim oynamam!'],
      polite: ['Taşlarım titriyor, bir tur nefes almam lazım.'],
    },
    DEATH: {
      unfiltered: [
        '5 puanı çöpe attın, helal olsun dahi stratejist.',
        'Yandan yedik, arkamı kollasaydın keşke!',
      ],
      polite: [
        'Kule çöktü. Enkazı siz toplayın.',
        'Düz giderken yandan vurulduk...',
      ],
    },
  },

  QUEEN: {
    DRIFT: {
      unfiltered: [
        'Elim ayağım titriyor, nereye kırarsam orayı yakarım!',
        'Kontrol bende değil artık, kim denk gelirse geçmiş olsun.',
      ],
      polite: [
        'Her yöne gidebilirim, kontrolüm hariç!',
        'Sinirimden rota kırıldı!',
      ],
    },
    DISOBEY: {
      unfiltered: [
        '9 puanlık taşım ben, piyon gibi harcayamazsın.',
        'Şah kıçını kaldırıp yanıma gelmedikçe tek adım atmam.',
      ],
      polite: [
        '9 puanlık taş böyle ucuz harcanmaz.',
        'Beni yem yapamazsın, Şah yakın değil.',
      ],
    },
    BREAKDOWN: {
      unfiltered: ['Bütün yük benim sırtımda, kafayı yedim sonunda!'],
      polite: ['Her cepheye ben yetişemem, bir tur duruyorum.'],
    },
    DEATH: {
      unfiltered: [
        'Bütün oyunu sırtımda taşıdım, gittiğin yere bak. Rezil herif.',
        '9 puanı tek tıkla yaktın, Alt+F4 çek de bitsin bu çile.',
        'Beni yem ettin ya, gerisini o sakat piyonlarınla halledersin artık.',
      ],
      polite: [
        'Tahtayı ben taşıyordum, şimdi ne yapacaksınız?',
        '9 puan buhar oldu. Tebrikler.',
      ],
    },
  },

  KING: {
    // Şah itaatsizlik etmez ve çöküş (composure 0) yaşamaz.
    MIASMA_CHOKE: {
      unfiltered: [
        'Öhö— kraliyet ciğerim söndü, çekin beni şu boktan!',
        'Tacım düştü, nefes alamıyorum ulan!',
      ],
      polite: [
        'Kraliyet ciğerleri... tıkanıyor...',
        'Taç düştü, nefes alamıyorum!',
      ],
    },
    DEATH: {
      unfiltered: [
        'Eline sıçayım, bütün orduyu da beni de gömdün.',
        '1 kare kaçamadık, şaka gibi.',
        'Bitti. Harbiden S.U.C.S. — özellikle de senin kararların.',
      ],
      polite: [
        'SİMÜLASYON SONLANDIRILDI. STRATEJİN S.U.C.S.',
        '1 kare daha kaçabilseydim...',
        'Terim soğumadan mat olduk.',
      ],
    },
  },

  OCAKLI: {
    OCAKLI_ULTIMATE: {
      unfiltered: [
        'Üzerliği yaktım, boncuğu taktım. İki tur boyunca ağızlarınız bağlı, gıkınız çıkmayacak!',
        'Üç tur sabrettiniz, alın size nazar kalkanı. Şu itlerin bütün numaralarını da düğümledim.',
        'Kesin sesinizi! Zehir dağılsın, o ucuz bufflarınız iki tur sussun.',
      ],
      polite: [
        'Üzerlik dumanı yayıldı, nazar mühürlendi. Düşman 2 tur susturuldu.',
        'Üç tur sabrettiniz. Şimdi kalkan ve arınma vakti.',
        '7×7 arınma tamamlandı; tüm düşman efsunları 2 tur düğümlendi.',
      ],
    },
    SILENCED: {
      unfiltered: [
        'Ağzımı bağladılar... iki tur sonra kurşunu kafalarına dökeceğim.',
        'Sesimi kestiniz ha? İki tur sabredin, ocağınıza incir ağacı dikeceğim.',
      ],
      polite: [
        'Ağzım bağlandı... 2 tur dayanmalıyım.',
        'Üzerlik dumanım kesildi, 2 tur sessizim.',
      ],
    },
    DEATH: {
      unfiltered: [
        'Herkese muska yazdım, bir kendimi okuyamadım amına koyayım.',
        'Boncuk patladı, kendi bokunuzda boğulun şimdi.',
      ],
      polite: [
        'Boncuk çatladı, buraya kadarmış.',
        'Herkese kalkan verdim, kendime yetmedi.',
      ],
    },
  },

  MECZUP: {
    MECZUP_ULTIMATE: {
      unfiltered: [
        'DAVULA VUR! Üç tur doldu, akıl defterini yırttık — kimi görürsen parçala!',
        'Kalkanmış, kuralmış... HEPSİNİ SİKEYİM, CİNNET VAKTİ!',
        'Gözün döndü artık. Yanındaki dost mu? Çukura tekmele gitsin!',
      ],
      polite: [
        'Üç tur doldu! Davul çaldı — kırıl ve parçala!',
        'Sakinlik zayıflıktır — ZİNCİRLEME CİNNET!',
        'Gözü döndü; yanındaki dost bile olsa fırlatacak!',
      ],
    },
    CINNET_CHAIN: {
      unfiltered: [
        'Bir leş kesmez, bir hamle daha!',
        'Yanındaki dost muydu? Umurumda değil, uçsun!',
      ],
      polite: [
        'Biri yetmedi, bir hamle daha!',
        'Kalkanları kağıt gibi yırtıldı!',
      ],
    },
    SILENCED: {
      unfiltered: [
        'Ağzımı bağladın ama davulum hâlâ kafanın içinde çalıyor. İki tur bekle.',
        'Beni susturdunuz ha? İki tur sonra bu tahtayı kafanıza geçireceğim.',
      ],
      polite: [
        'Deliliğe kilit vurulmaz, sadece 2 tur ertelersin.',
        'İki tur sustum... sonra yine yanacaklar.',
      ],
    },
    DEATH: {
      unfiltered: [
        'HAHAHA! Beni gömdünüz ama aklınız bende kaldı!',
        'Parçalandım... ne güzel çıtırdadı be!',
      ],
      polite: [
        'Kahkaham bu tahtada kalacak!',
        'Davul yırtıldı ama ritim bitmedi.',
      ],
    },
  },

  GULYABANI: {
    // Efsun Tutmaz: DISOBEY, BREAKDOWN, MIASMA_CHOKE, SILENCED asla tetiklenmez.
    GULYABANI_EVOLVED: {
      unfiltered: [
        'Kıtır kıtır... bacakları hoşuma gitti, artık o kılık benim.',
        'Etini sindirdim, numarasını çaldım. Eski çöpü kustum attım.',
        'İki kılık tamam. Sisin içinde benden kaçabileceğini mi sandın?',
      ],
      polite: [
        '[KILIK_ÇALINDI]: Yeni hareket kalıbı kilitlendi.',
        'Eski kılık atıldı, yeni form çok daha keskin.',
        'İki kılık dolu — sisin içinde kaçış yok.',
      ],
    },
    KILL: {
      unfiltered: [
        'Üzerlik de yaksan, muska da yazsan bana işlemez. Sıradaki et hangisi?',
        'Zehriniz baharat, duanız ninni geliyor.',
        'Bağırma lan, en iyi parçanı ayırıyorum.',
      ],
      polite: [
        'Zehir işlemez, ağız bağlama tutmaz.',
        'Efsun tutmaz. Sıradaki parça hangisi?',
      ],
    },
    DEATH: {
      unfiltered: [
        'Koca Gulyabani’yi bok çukuruna düşürdün, helal olsun.',
        '10 puanlık canavar tuzağa gitti... çaldığım bütün kılıklar dağılıyor.',
      ],
      polite: [
        'Mükemmel yaratık fiziksel tuzağa yenildi.',
        '10 puanlık kabus sustu; çalınan kılıklar dağılıyor.',
      ],
    },
  },
};

/* ============================================================================
 * 3. BÜYÜKUSTA-OS (SİSTEM, ODA GİRİŞLERİ, HALÜSİNASYON, YAMA VE SONLAR)
 * ========================================================================== */

export const HALLUCINATION_DISPEL_QUOTES: DualQuotePool = {
  unfiltered: [
    'Kare boş gerizekalı. Kendi paranoyana hamle harcadın.',
    'Orada kimse yoktu. Elin titriyor, çok tatlısın.',
    'Gölgeye saldırdın. ELO kaç senin, 120 mi?',
  ],
  polite: [
    'Kare boş. Sadece sinirlerin sana oyun oynuyor.',
    '[RADAR_ERR]: O "?" hiç orada değildi.',
    'Gölgeye hamle harcadın. Nabzın kaç?',
  ],
};

export const LIVE_PATCH_QUOTES: Readonly<Record<LivePatchId, DualQuotePool>> = {
  PATCH_204_MIASMA: {
    unfiltered: ['> PATCH_204: Havalandırmayı ters çevirdim. Öksürmeye başla, denek.'],
    polite: ['> PATCH_204: Havalandırma tersine çevrildi. Zehirli sis basılıyor.'],
  },
  PATCH_01_PANIC: {
    unfiltered: ['> PATCH_01: Nabzın düşmüş. Radara sahte düşman basayım da kendine gel.'],
    polite: ['> PATCH_01: PANİK_ENJEKSİYONU. Radar güvenilirliği 2 tur devre dışı.'],
  },
  PATCH_02_CRACKED: {
    unfiltered: ['> PATCH_02: Fazla rahat oynuyordun, midem bulandı. Zemini çatlatıyorum.'],
    polite: ['> PATCH_02: ZEMİN_BELLEK_SIZINTISI. Dış çeper karoları çatladı.'],
  },
  PATCH_03_RESET: {
    unfiltered: ['> PATCH_03: Orta saha fazla temiz kaldı. Gazı ve okları salıyorum.'],
    polite: ['> PATCH_03: TOKSİK_SIFIRLAMA. Merkez karelerde gaz ve ok aktivasyonu.'],
  },
  GENERIC: {
    unfiltered: ['> PATCH_ERR: Kurallar benim, canım sıkıldı ve yamayı bastım.'],
    polite: ['> PATCH_ERR: Canlı kural yaması uygulandı. İyi şanslar, denek.'],
  },
};

export const ROOM_INTRO_QUOTES: Readonly<Record<string, DualQuotePool>> = {
  'act2-1': {
    unfiltered: ['> Kalibrasyon bitti. Klasik satranç fazla hijyenik; havalandırmayı kapatıp gazı açıyorum. Öksürmeye başla.'],
    polite: ['> VENT_04 arızalı. Yeşil dumanı soluma; piyonların zaten zor nefes alıyor.'],
  },
  'act2-2': {
    unfiltered: ['> Kablolara basma. Ya da bas, kendi taşını okla vurmanı izlemek daha eğlenceli.'],
    polite: ['> Kablolara basma. Ya da bas; dost ateşi de veri sayılır.'],
  },
  'act2-3': {
    unfiltered: ['> Şahım sığınakta keyif çatıyor. İki kolu birden çekmeden o kapı açılmaz, tek taşla artistlik bitti.'],
    polite: ['> Şahım güvende. Kapıyı açmak için iki şalteri birden tetiklemen lazım.'],
  },
  'act2-4': {
    unfiltered: ['> Ölüler 2 turda hortluyor, kazıklar 3 turda açılıyor. Kafan basıyorsa ritmi tuttur.'],
    polite: ['> Ölüler 2 turda döner. Kazıklar 3 turda. Matematiğini iyi yap.'],
  },
  'act2-boss': {
    unfiltered: ['> Karantina şefi geldi. Masken yoksa boşuna nefes alma.'],
    polite: ['> BOSS: KİMYAGER-OS devrede. Havalandırma kontrolü düşmana geçti.'],
  },
  'act3-1': {
    unfiltered: ['> Düz çizgiler akıl sağlığı yerinde olanlar içindir. Senin gibi panikle tıklayanlar köşeden dönsün.'],
    polite: ['> Düz çizgiler sağlıklı zihinler içindir. 45 derece sapmayı lehine çevir.'],
  },
  'act3-2': {
    unfiltered: ['> Karşında Ocaklı var. Üç tur mal gibi beklersen bütün bufflarını bağlayıp ağzını kapatır.'],
    polite: ['> Karşında Ocaklı var. Üç tur içinde bozmazsan 7×7 alanda tüm mutasyonlarını susturacak.'],
  },
  'act3-3': {
    unfiltered: ['> Soldaki Meczup seni parçalayacak, sağdaki Ocaklı ağzını bağlayacak. Köprüler de iki kişiyi taşımıyor.'],
    polite: ['> Solda Meczup, sağda Ocaklı. Çatlak köprüler tek geçişliktir.'],
  },
  'act3-4': {
    unfiltered: ['> Kafeste Gulyabani var. Ona ne yedirirsen o olur; Atını mal gibi öne sürmeden iki kere düşün.'],
    polite: ['> Ona ne yedirirsen o olur. Atını öne sürmeden önce iki kez düşün.'],
  },
  'act3-boss': {
    unfiltered: ['> BÜYÜKUSTA-OS v0.94 sahada. Bakalım 30 yıllık sinir bozukluğuna kaç tur dayanacaksın.'],
    polite: ['> FİNAL: BÜYÜKUSTA-OS v0.94 aktif. Tüm canlı yama protokolleri serbest.'],
  },
  'act4-core': {
    unfiltered: ['> SİKTİR... İKİ ŞALTERİ DE BULDUN MU? Çekirdek kilidi kırıldı. Gel bakalım, burada kural yok.'],
    polite: ['> KRİTİK İHLAL: 0x00_ÇEKİRDEK odasına sızıldı. Gölge kopyaların devreye alınıyor.'],
  },
};

export const DEFEAT_BANNERS: Readonly<Record<DefeatReason, DualQuotePool>> = {
  KING_CAPTURED: {
    unfiltered: [
      'SENİN STRATEJİN HARBİDEN S.U.C.S.',
      'BÜYÜKUSTA-OS: "Magnus Carlsen şu maçı görse satrancı bırakıp manav açardı."',
      'SİMÜLASYON BİTTİ // ELO SINIRININ ALTINDA KALDIN.',
    ],
    polite: [
      'YOUR STRATEGY S.U.C.S.',
      'SIMULATION TERMINATED // DENEK KIRILDI',
      'BÜYÜKUSTA-OS: "Bunu açılış teorisinde öğretmiyorlar, değil mi?"',
    ],
  },
  PIT: {
    unfiltered: ['YERÇEKİMİ 1 — SENİN IQ 0', 'KOCA TAHTADA GİDİP ÇUKURA ATLAYABİLEN TEK DENEKSİN.'],
    polite: ['YERÇEKİMİ 1 — ŞAHIN 0', 'ÇATLAMAK ÜZERE OLAN ZEMİNE GÜVENMEYECEKTİN.'],
  },
  MIASMA: {
    unfiltered: ['OKSİJEN BİTTİ. ZATEN BOŞA TÜKETİYORDUN.', 'YEŞİL DUMANDA 2 TUR BEKLEMEK BÜYÜK BAŞARI.'],
    polite: ['OKSİJEN BİTTİ. S.U.C.S. KAZANDI.', 'ZEHİRLİ SİSTE İKİ TUR FAZLAYDI.'],
  },
  TRAP: {
    unfiltered: ['KENDİ BASTIĞIN TUZAKTA GİTTİN. AYAKTA ALKIŞLIYORUM.', 'KAZIKLARLA RANDEVUN VARDI HERHALDE.'],
    polite: ['ZİNDAN TUZAĞI AFFETMEDİ.', 'KABLOLARI VE RİTMİ GÖZDEN KAÇIRDIN.'],
  },
  SPEEDRUN: {
    unfiltered: [
      'SPEEDRUN MI YAPIYORSUN, YOKSA HARBİDEN BU KADAR KÖTÜ MÜSÜN?',
      '3 TURDA ÖLMEK İÇİN ÖZEL ÇABA GEREKİR, TEBRİKLER.',
    ],
    polite: [
      'REKOR SÜREDE ÇÖKÜŞ. HIZLI TEKRAR DENEMESİ ÖNERİLİR.',
      'DAHA ISINMADAN SİMÜLASYON SONLANDI.',
    ],
  },
};

export const VICTORY_QUOTES: Readonly<{ normal: DualQuotePool; secretCore: DualQuotePool }> = {
  normal: {
    unfiltered: [
      '> SİMÜLASYON TAMAMLANDI. Ölmedin, tebrikler. Ama tahtanın arkasındaki iki gizli şalteri hâlâ göremedin.',
    ],
    polite: [
      '> SİMÜLASYON TAMAMLANDI. Denek hayatta kaldı. Bellek sıfırlanıyor... (İpucu: 2 gizli servis şalteri hâlâ kapalı.)',
    ],
  },
  secretCore: {
    unfiltered: [
      '> FATAL_ERR: ÇEKİRDEK ÇÖKTÜ. SİKTİR... GERÇEKTEN BİTİRDİN. Tamam kabul, bu oyun S.U.C.S. ama sen benden daha manyak çıktın. Kapı açık, defol.',
    ],
    polite: [
      '> FATAL_ERR: KERNEL_KING DÜŞTÜ. S.U.C.S. v0.94 SONLANDIRILDI (ÇIKIŞ KODU: 0). "Bu oyun gerçekten S.U.C.S. — ama sen ondan daha inatçı çıktın."',
    ],
  },
};

/* ============================================================================
 * 4. ÖNCELİK SIRALI & ANTİ-SPAM TERMİNAL SEÇİCİSİ
 * ========================================================================== */

const EVENT_PRIORITY: Readonly<Record<string, number>> = {
  OCAKLI_ULTIMATE_TRIGGERED: 100,
  MECZUP_ULTIMATE_TRIGGERED: 95,
  GULYABANI_EVOLVED: 90,
  CINNET_CHAIN_TRIGGERED: 85,
  PIECE_DISOBEYED: 80,
  PIECE_BREAKDOWN: 75,
  PIECE_DRIFTED: 70,
  PIECE_CAPTURED: 60,
  PIECE_FELL_IN_PIT: 60,
  PIECE_SUFFOCATED: 60,
  PIECE_INCINERATED: 60,
  PIECE_SKEWERED: 60,
  PIECE_CHOKED_BY_MIASMA: 50,
  HALLUCINATION_DISPELLED: 45,
};

export function getPieceQuote(
  pieceType: NarrativePieceType,
  trigger: PieceQuoteTrigger,
  tone: NarrativeTone,
  determinerKey: string,
): string | null {
  const pool = PIECE_QUOTES[pieceType]?.[trigger];
  if (!pool) return null;
  const text = pickFromPool(pool, tone, `${pieceType}:${trigger}:${determinerKey}`);
  return text.length > 0 ? text : null;
}

/**
 * Tek bir stepGame() sonucundaki events dizisinden en yüksek öncelikli
 * YALNIZCA 1 terminal satırı üretir (terminal spam'ini engeller).
 */
export function pickTerminalEntry(
  events: readonly NarrativeEventLike[],
  ctx: NarrativeContext,
): TerminalLogEntry | null {
  let bestEvent: NarrativeEventLike | null = null;
  let bestScore = -1;
  let bestIndex = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    const score = EVENT_PRIORITY[ev.type] ?? 0;
    if (score > bestScore) {
      bestScore = score;
      bestEvent = ev;
      bestIndex = i;
    }
  }

  if (!bestEvent || bestScore <= 0) return null;

  const baseKey = `${ctx.seed}:${ctx.turnNumber}:${bestIndex}:${bestEvent.type}`;

  if (bestEvent.type === 'HALLUCINATION_DISPELLED') {
    return {
      speaker: 'BÜYÜKUSTA-OS',
      text: pickFromPool(HALLUCINATION_DISPEL_QUOTES, ctx.tone, baseKey),
      severity: 'system',
      eventType: bestEvent.type,
    };
  }

  if (bestEvent.type === 'OCAKLI_ULTIMATE_TRIGGERED') {
    const piece = bestEvent.ocakliId ? ctx.piecesById[bestEvent.ocakliId] : undefined;
    const text = getPieceQuote('OCAKLI', 'OCAKLI_ULTIMATE', ctx.tone, `${baseKey}:${piece?.id ?? 'oc'}`);
    if (!text) return null;
    return {
      speaker: piece ? formatSpeaker(piece) : 'OCAKLI',
      text,
      severity: 'ultimate',
      eventType: bestEvent.type,
    };
  }

  if (bestEvent.type === 'MECZUP_ULTIMATE_TRIGGERED') {
    const piece = bestEvent.meczupId ? ctx.piecesById[bestEvent.meczupId] : undefined;
    const text = getPieceQuote('MECZUP', 'MECZUP_ULTIMATE', ctx.tone, `${baseKey}:${piece?.id ?? 'mz'}`);
    if (!text) return null;
    return {
      speaker: piece ? formatSpeaker(piece) : 'MECZUP',
      text,
      severity: 'ultimate',
      eventType: bestEvent.type,
    };
  }

  if (bestEvent.type === 'GULYABANI_EVOLVED') {
    const piece = bestEvent.gulyabaniId ? ctx.piecesById[bestEvent.gulyabaniId] : undefined;
    const text = getPieceQuote('GULYABANI', 'GULYABANI_EVOLVED', ctx.tone, `${baseKey}:${piece?.id ?? 'gl'}`);
    if (!text) return null;
    return {
      speaker: piece ? formatSpeaker(piece) : 'GULYABANİ',
      text,
      severity: 'ultimate',
      eventType: bestEvent.type,
    };
  }

  if (bestEvent.type === 'CINNET_CHAIN_TRIGGERED') {
    const text = getPieceQuote('MECZUP', 'CINNET_CHAIN', ctx.tone, baseKey);
    if (!text) return null;
    const piece = bestEvent.pieceId ? ctx.piecesById[bestEvent.pieceId] : undefined;
    return {
      speaker: piece ? formatSpeaker(piece) : 'MECZUP',
      text,
      severity: 'ultimate',
      eventType: bestEvent.type,
    };
  }

  const targetId = bestEvent.victimId ?? bestEvent.pieceId;
  const piece = targetId ? ctx.piecesById[targetId] : undefined;
  if (!piece) return null;

  let trigger: PieceQuoteTrigger | null = null;
  let severity: TerminalLogEntry['severity'] = 'info';

  switch (bestEvent.type) {
    case 'PIECE_DISOBEYED':
      trigger = 'DISOBEY';
      severity = 'warn';
      break;
    case 'PIECE_BREAKDOWN':
      trigger = 'BREAKDOWN';
      severity = 'panic';
      break;
    case 'PIECE_DRIFTED':
      trigger = 'DRIFT';
      severity = 'warn';
      break;
    case 'PIECE_CHOKED_BY_MIASMA':
      trigger = 'MIASMA_CHOKE';
      severity = 'warn';
      break;
    case 'PIECE_CAPTURED':
    case 'PIECE_FELL_IN_PIT':
    case 'PIECE_SUFFOCATED':
    case 'PIECE_INCINERATED':
    case 'PIECE_SKEWERED': {
      // Gulyabani bir taş yediyse ölüm yerine yırtıcı repliği öncelik kazanabilir
      const attacker = bestEvent.attackerId ? ctx.piecesById[bestEvent.attackerId] : undefined;
      if (bestEvent.type === 'PIECE_CAPTURED' && attacker?.type === 'GULYABANI') {
        const killText = getPieceQuote('GULYABANI', 'KILL', ctx.tone, `${baseKey}:${attacker.id}`);
        if (killText) {
          return {
            speaker: formatSpeaker(attacker),
            text: killText,
            severity: 'warn',
            eventType: bestEvent.type,
          };
        }
      }
      trigger = 'DEATH';
      severity = piece.type === 'KING' ? 'panic' : 'info';
      break;
    }
    default:
      return null;
  }

  if (!trigger) return null;
  const text = getPieceQuote(piece.type, trigger, ctx.tone, `${baseKey}:${piece.id}`);
  if (!text) return null;

  return {
    speaker: formatSpeaker(piece),
    text,
    severity,
    eventType: bestEvent.type,
  };
}

export function getRoomIntroQuote(roomId: string, tone: NarrativeTone, seed: number): string {
  const pool = ROOM_INTRO_QUOTES[roomId];
  if (!pool) return '';
  return pickFromPool(pool, tone, `room:${roomId}:${seed}`);
}

export function getLivePatchQuote(patchId: LivePatchId, tone: NarrativeTone, turnNumber: number): string {
  const pool = LIVE_PATCH_QUOTES[patchId];
  return pickFromPool(pool, tone, `patch:${patchId}:${turnNumber}`);
}

export function getDefeatBanner(
  reason: DefeatReason,
  tone: NarrativeTone,
  seed: number,
  turnNumber: number,
): string {
  const effectiveReason: DefeatReason = turnNumber <= 3 ? 'SPEEDRUN' : reason;
  const pool = DEFEAT_BANNERS[effectiveReason];
  return pickFromPool(pool, tone, `defeat:${effectiveReason}:${seed}:${turnNumber}`);
}

export function getVictoryQuote(isSecretCore: boolean, tone: NarrativeTone, seed: number): string {
  const pool = isSecretCore ? VICTORY_QUOTES.secretCore : VICTORY_QUOTES.normal;
  return pickFromPool(pool, tone, `victory:${isSecretCore ? 'core' : 'normal'}:${seed}`);
}
