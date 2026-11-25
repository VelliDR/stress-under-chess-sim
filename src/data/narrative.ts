// src/data/narrative.ts
// S.U.C.S. — Stress Under Chess Simulator
// Saf, %100 deterministik (Math.random() içermez) çift tonlu terminal diyalog motoru.
// v2_yama.md ile %100 uyumludur; hem motor tiplerini (SAINT_FAITH/SAINT_MADNESS/CHIMERA)
// hem de yerel folklor adlarını (OCAKLI/MECZUP/GULYABANI) şeffaf biçimde destekler.

import type { MatchEndReason, Piece, PieceType } from '../engine/types';

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
  readonly pos?: { readonly x: number; readonly y: number };
}

/**
 * reducer.ts'ten dönen GameEvent nesneleriyle ve v2_yama.md olay şemasıyla yapısal uyumludur.
 */
export interface NarrativeEventLike {
  readonly type: string;
  readonly pieceId?: string;
  readonly attackerId?: string;
  readonly byPieceId?: string;
  readonly victimId?: string;
  readonly saintId?: string;
  readonly ocakliId?: string;
  readonly meczupId?: string;
  readonly chimeraId?: string;
  readonly gulyabaniId?: string;
  readonly targetId?: string;
  readonly killed?: boolean;
  readonly silencedEnemyIds?: readonly string[];
  readonly at?: { readonly x: number; readonly y: number };
  readonly pos?: { readonly x: number; readonly y: number };
  readonly pulseOrigin?: { readonly x: number; readonly y: number };
  readonly path?: ReadonlyArray<{ readonly x: number; readonly y: number }>;
}

export interface NarrativeContext {
  readonly seed: number;
  readonly turnNumber: number;
  readonly tone: NarrativeTone;
  /** Hamle öncesi ve sonrası bilinen taşların id -> taş eşlemesi (ölen taşları bulmak için) */
  readonly piecesById: Readonly<Record<string, NarrativePieceRef>>;
}

export type SpeechOverlayLayer = 'BARK' | 'LAST_WORDS' | 'CRT_BAND';

export interface TerminalLogEntry {
  readonly speaker: string;
  readonly text: string;
  readonly richText?: string;
  readonly severity: 'info' | 'warn' | 'panic' | 'ultimate' | 'system';
  readonly eventType: string;
  readonly layer?: SpeechOverlayLayer;
  readonly pieceType?: NarrativePieceType;
  readonly pieceId?: string;
  readonly coord?: { readonly x: number; readonly y: number };
}

/* ============================================================================
 * 0. MOTOR <-> FOLKLOR DÖNÜŞTÜRÜCÜLER
 * ========================================================================== */

export function toNarrativePieceType(type: PieceType | NarrativePieceType): NarrativePieceType {
  if (type === 'SAINT_FAITH') return 'OCAKLI';
  if (type === 'SAINT_MADNESS') return 'MECZUP';
  if (type === 'CHIMERA') return 'GULYABANI';
  return type;
}

export function buildNarrativePieceMap(
  ...pieceLists: ReadonlyArray<readonly Piece[]>
): Record<string, NarrativePieceRef> {
  const map: Record<string, NarrativePieceRef> = {};
  for (let l = 0; l < pieceLists.length; l++) {
    const list = pieceLists[l]!;
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      map[p.id] = {
        id: p.id,
        type: toNarrativePieceType(p.type),
        side: p.side,
        pos: { x: p.pos.x, y: p.pos.y },
      };
    }
  }
  return map;
}

export function mapMatchEndToDefeatReason(reason: MatchEndReason | undefined): DefeatReason {
  switch (reason) {
    case 'KING_FELL_IN_PIT':
      return 'PIT';
    case 'KING_SUFFOCATED':
      return 'MIASMA';
    case 'KING_SKEWERED':
    case 'KING_INCINERATED':
    case 'KING_BURNED':
      return 'TRAP';
    default:
      return 'KING_CAPTURED';
  }
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

const RICH_SHAKE_RX =
  /(PANİK_ENJEKSİYONU|PANİK|CİNNET VAKTİ|ZİNCİRLEME CİNNET|CİNNET|HEPSİNİ|DAVULA VUR|SİKTİR|KAFAYI YEDİM|SİNİR|İTAATSİZ|FATAL_ERR|KRİTİK İHLAL)/g;
const RICH_WAVE_RX =
  /(hardal gazı|gölgeye|gölge|üzerlik dumanı|dumanı|duman|zehirli sis|zehir|sisin|sisi|sis|fısıldıyor|fısıltı|nefes)/gi;
const RICH_POP_RX =
  /(S\.U\.C\.S\.|Üç tur|ÜÇ TUR|3 TUR|3 tur|BONCUK ÇATLADI|Boncuk çatladı|Boncuk patladı|EFSUN TUTMAZ|Efsun tutmaz|KILIK_ÇALINDI|PATCH_204|PATCH_01|PATCH_02|PATCH_03|PATCH_ERR|KERNEL_KING|7×7|10 puanlık)/gi;

/**
 * 3.1 Metin İçi Duygu Etiketleyicisi:
 * Eğer metin hâlihazırda etiket taşımıyorsa kritik duygu kelimelerini {shake}/{wave}/{pop} ile sarar.
 */
export function enrichNarrativeMarkup(input: string): string {
  if (/\{(shake|wave|pop)\}/.test(input)) return input;
  // Pass 1: exact high-priority tags without nesting collisions (replace on unannotated segments)
  const segments: Array<{ raw: string; tagged: boolean }> = [{ raw: input, tagged: false }];

  const applyRx = (rx: RegExp, tag: 'shake' | 'wave' | 'pop'): void => {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (seg.tagged) continue;
      rx.lastIndex = 0;
      const parts: Array<{ raw: string; tagged: boolean }> = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = rx.exec(seg.raw)) !== null) {
        if (m.index > last) {
          parts.push({ raw: seg.raw.slice(last, m.index), tagged: false });
        }
        parts.push({ raw: `{${tag}}${m[0]}{/${tag}}`, tagged: true });
        last = m.index + m[0].length;
      }
      if (parts.length > 0) {
        if (last < seg.raw.length) {
          parts.push({ raw: seg.raw.slice(last), tagged: false });
        }
        segments.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    }
  };

  applyRx(RICH_POP_RX, 'pop');
  applyRx(RICH_SHAKE_RX, 'shake');
  applyRx(RICH_WAVE_RX, 'wave');
  return segments.map((s) => s.raw).join('');
}

export function stripRichTags(markup: string): string {
  return markup.replace(/\{\/?(shake|wave|pop)\}/g, '');
}

export function getMenuTickerQuotes(tone: NarrativeTone): readonly string[] {
  return tone === 'unfiltered'
    ? [
        '> BÜYÜKUSTA-OS v0.94 // "30 yıllık ELO hasarı aktif. Piyonların bile senden nefret ediyor."',
        '> HATIRLATMA: Hardal gazına ateşle vurursan {pop}25 ms{/pop} domino zincirini izlersin — kendi şahın hariç.',
        '> SİSTEM NOTU: 2 gizli servis şalteri hâlâ kapalı. Sıkıysa {shake}0x00_ÇEKİRDEK{/shake} kilidini aç.',
        '> CANLI TELEMETRİ: Stres 75 üstüne çıkarsa {wave}gölgeler{/wave} tahtada kıpırdamaya başlar.',
      ]
    : [
        '> BÜYÜKUSTA-OS v0.94 // Takım dayanıklılığı ve hardal gazı simülasyonu çevrimiçi.',
        '> HATIRLATMA: Miasma bulutunu alevli okla tutuşturursan {pop}7×7{/pop} kimya reaksiyonu tetiklenir.',
        '> SİSTEM NOTU: Perde 2 ve Perde 3 içindeki iki gizli şalter henüz etkinleştirilmedi.',
        '> CANLI TELEMETRİ: Yüksek stres altında {wave}halüsinasyon silüetleri{/wave} radarda belirebilir.',
      ];
}

const EVENT_PRIORITY: Readonly<Record<string, number>> = {
  OCAKLI_ULTIMATE_TRIGGERED: 100,
  FAITH_ULTIMATE_TRIGGERED: 100,
  MECZUP_ULTIMATE_TRIGGERED: 95,
  MADNESS_ULTIMATE_TRIGGERED: 95,
  GULYABANI_EVOLVED: 90,
  CHIMERA_EVOLVED: 90,
  CINNET_CHAIN_TRIGGERED: 85,
  BERSERK_CHAIN_TRIGGERED: 85,
  PIECE_DISOBEYED: 80,
  PIECE_BREAKDOWN: 75,
  PIECE_DRIFTED: 70,
  PIECE_CAPTURED: 60,
  PIECE_FELL_IN_PIT: 60,
  PIECE_SUFFOCATED: 60,
  PIECE_INCINERATED: 60,
  PIECE_SKEWERED: 60,
  PIECE_BURNED: 58,
  PIECE_CHOKED_BY_MIASMA: 50,
  HALLUCINATION_DISPELLED: 45,
};

export function getPieceQuote(
  pieceType: NarrativePieceType | PieceType,
  trigger: PieceQuoteTrigger,
  tone: NarrativeTone,
  determinerKey: string,
): string | null {
  const normalized = toNarrativePieceType(pieceType);
  const pool = PIECE_QUOTES[normalized]?.[trigger];
  if (!pool) return null;
  const text = pickFromPool(pool, tone, `${normalized}:${trigger}:${determinerKey}`);
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
    if (ev.type === 'PIECE_BURNED' && ev.killed !== true) continue;
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
    const plain = pickFromPool(HALLUCINATION_DISPEL_QUOTES, ctx.tone, baseKey);
    return {
      speaker: 'BÜYÜKUSTA-OS',
      text: plain,
      richText: enrichNarrativeMarkup(plain),
      severity: 'system',
      eventType: bestEvent.type,
      layer: 'CRT_BAND',
      coord: bestEvent.at ?? bestEvent.pos,
    };
  }

  if (
    bestEvent.type === 'OCAKLI_ULTIMATE_TRIGGERED' ||
    bestEvent.type === 'FAITH_ULTIMATE_TRIGGERED'
  ) {
    const sid = bestEvent.ocakliId ?? bestEvent.saintId;
    const piece = sid ? ctx.piecesById[sid] : undefined;
    const text = getPieceQuote('OCAKLI', 'OCAKLI_ULTIMATE', ctx.tone, `${baseKey}:${piece?.id ?? 'oc'}`);
    if (!text) return null;
    return {
      speaker: piece ? formatSpeaker(piece) : 'OCAKLI',
      text,
      richText: enrichNarrativeMarkup(text),
      severity: 'ultimate',
      eventType: bestEvent.type,
      layer: 'BARK',
      pieceType: 'OCAKLI',
      pieceId: piece?.id ?? sid,
      coord: bestEvent.pulseOrigin ?? bestEvent.at ?? piece?.pos,
    };
  }

  if (
    bestEvent.type === 'MECZUP_ULTIMATE_TRIGGERED' ||
    bestEvent.type === 'MADNESS_ULTIMATE_TRIGGERED'
  ) {
    const mid = bestEvent.meczupId ?? bestEvent.saintId;
    const piece = mid ? ctx.piecesById[mid] : undefined;
    const text = getPieceQuote('MECZUP', 'MECZUP_ULTIMATE', ctx.tone, `${baseKey}:${piece?.id ?? 'mz'}`);
    if (!text) return null;
    return {
      speaker: piece ? formatSpeaker(piece) : 'MECZUP',
      text,
      richText: enrichNarrativeMarkup(text),
      severity: 'ultimate',
      eventType: bestEvent.type,
      layer: 'BARK',
      pieceType: 'MECZUP',
      pieceId: piece?.id ?? mid,
      coord: piece?.pos ?? bestEvent.at,
    };
  }

  if (bestEvent.type === 'GULYABANI_EVOLVED' || bestEvent.type === 'CHIMERA_EVOLVED') {
    const gid = bestEvent.gulyabaniId ?? bestEvent.chimeraId;
    const piece = gid ? ctx.piecesById[gid] : undefined;
    const text = getPieceQuote('GULYABANI', 'GULYABANI_EVOLVED', ctx.tone, `${baseKey}:${piece?.id ?? 'gl'}`);
    if (!text) return null;
    return {
      speaker: piece ? formatSpeaker(piece) : 'GULYABANİ',
      text,
      richText: enrichNarrativeMarkup(text),
      severity: 'ultimate',
      eventType: bestEvent.type,
      layer: 'BARK',
      pieceType: 'GULYABANI',
      pieceId: piece?.id ?? gid,
      coord: piece?.pos ?? bestEvent.at ?? bestEvent.pos,
    };
  }

  if (
    bestEvent.type === 'CINNET_CHAIN_TRIGGERED' ||
    bestEvent.type === 'BERSERK_CHAIN_TRIGGERED'
  ) {
    const text = getPieceQuote('MECZUP', 'CINNET_CHAIN', ctx.tone, baseKey);
    if (!text) return null;
    const piece = bestEvent.pieceId ? ctx.piecesById[bestEvent.pieceId] : undefined;
    return {
      speaker: piece ? formatSpeaker(piece) : 'MECZUP',
      text,
      richText: enrichNarrativeMarkup(text),
      severity: 'ultimate',
      eventType: bestEvent.type,
      layer: 'BARK',
      pieceType: piece?.type ?? 'MECZUP',
      pieceId: piece?.id ?? bestEvent.pieceId,
      coord: bestEvent.at ?? piece?.pos,
    };
  }

  const targetId = bestEvent.victimId ?? bestEvent.pieceId;
  const piece = targetId ? ctx.piecesById[targetId] : undefined;
  if (!piece) return null;

  let trigger: PieceQuoteTrigger | null = null;
  let severity: TerminalLogEntry['severity'] = 'info';
  let layer: SpeechOverlayLayer = 'BARK';

  switch (bestEvent.type) {
    case 'PIECE_DISOBEYED':
      trigger = 'DISOBEY';
      severity = 'warn';
      layer = 'BARK';
      break;
    case 'PIECE_BREAKDOWN':
      trigger = 'BREAKDOWN';
      severity = 'panic';
      layer = 'BARK';
      break;
    case 'PIECE_DRIFTED':
      trigger = 'DRIFT';
      severity = 'warn';
      layer = 'BARK';
      break;
    case 'PIECE_CHOKED_BY_MIASMA':
      trigger = 'MIASMA_CHOKE';
      severity = 'warn';
      layer = 'BARK';
      break;
    case 'PIECE_CAPTURED':
    case 'PIECE_FELL_IN_PIT':
    case 'PIECE_SUFFOCATED':
    case 'PIECE_INCINERATED':
    case 'PIECE_SKEWERED':
    case 'PIECE_BURNED': {
      const attackerKey = bestEvent.attackerId ?? bestEvent.byPieceId;
      const attacker = attackerKey ? ctx.piecesById[attackerKey] : undefined;
      const deathCoord = bestEvent.at ?? bestEvent.pos ?? piece.pos;
      if (bestEvent.type === 'PIECE_CAPTURED' && attacker?.type === 'GULYABANI') {
        const killText = getPieceQuote('GULYABANI', 'KILL', ctx.tone, `${baseKey}:${attacker.id}`);
        if (killText) {
          return {
            speaker: formatSpeaker(attacker),
            text: killText,
            richText: enrichNarrativeMarkup(killText),
            severity: 'warn',
            eventType: bestEvent.type,
            layer: 'LAST_WORDS',
            pieceType: piece.type,
            pieceId: attacker.id,
            coord: deathCoord,
          };
        }
      }
      trigger = 'DEATH';
      severity = piece.type === 'KING' ? 'panic' : 'info';
      layer = 'LAST_WORDS';
      break;
    }
    default:
      return null;
  }

  if (!trigger) return null;
  const text = getPieceQuote(piece.type, trigger, ctx.tone, `${baseKey}:${piece.id}`);
  if (!text) return null;

  const fallbackPathCoord = bestEvent.path?.[bestEvent.path.length - 1];
  const coord = bestEvent.at ?? bestEvent.pos ?? fallbackPathCoord ?? piece.pos;

  return {
    speaker: formatSpeaker(piece),
    text,
    richText: enrichNarrativeMarkup(text),
    severity,
    eventType: bestEvent.type,
    layer,
    pieceType: piece.type,
    pieceId: piece.id,
    coord,
  };
}

export function getRoomIntroQuote(roomId: string, tone: NarrativeTone, seed: number): string {
  const pool = ROOM_INTRO_QUOTES[roomId];
  if (!pool) return '';
  return pickFromPool(pool, tone, `room:${roomId}:${seed}`);
}

export function getLivePatchQuote(
  patchId: LivePatchId,
  tone: NarrativeTone,
  turnNumber: number,
): string {
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

export function getVictoryQuote(
  isSecretCore: boolean,
  tone: NarrativeTone,
  seed: number,
): string {
  const pool = isSecretCore ? VICTORY_QUOTES.secretCore : VICTORY_QUOTES.normal;
  return pickFromPool(pool, tone, `victory:${isSecretCore ? 'core' : 'normal'}:${seed}`);
}
