// src/ui/settingsModal.ts
// S.U.C.S. — 3 Bloklu Sistem ve Ayarlar Modalı:
// Blok 1 (Ton & Atmosfer + canlı piyon repliği önizleme), Blok 2 (Oynanış), Blok 3 (Ses & JSON Dışa/İçe Aktarım + Çift Onaylı Sıfırlama).

import { getPieceQuote, type NarrativeTone } from '../data/narrative';
import type { AppSettings } from '../engine/types';
import type { CrtScanlineMode, UiPrefsState } from '../storage/uiPrefs';

export interface SettingsModalOptions {
  settings: AppSettings;
  prefs: UiPrefsState;
  exportJson: () => string;
  importJson: (raw: string) => { ok: boolean; error?: string };
  onUpdate: (next: {
    narrativeTone: NarrativeTone;
    crtScanlines: CrtScanlineMode;
    crtThemeEnabled: boolean;
    calmScreen: boolean;
    animationSpeed: 1 | 2;
    showIntentArrows: boolean;
    showLethalWarnings: boolean;
    soundEnabled: boolean;
    soundVolume: number;
  }) => void;
  onPlayTestSfx: () => void;
  onPlayClickSfx: () => void;
  onResetAllProgress: () => void;
  onClose?: () => void;
}

export class SettingsModal {
  private readonly opts: SettingsModalOptions;
  private overlayEl: HTMLDivElement | null = null;

  public constructor(opts: SettingsModalOptions) {
    this.opts = opts;
  }

  public isOpen(): boolean {
    return this.overlayEl !== null;
  }

  public open(parent: HTMLElement = document.body): void {
    this.close();

    let curTone: NarrativeTone = this.opts.settings.narrativeTone ?? 'unfiltered';
    let curScanlines: CrtScanlineMode = this.opts.prefs.crtScanlines;
    let curCrtTheme = this.opts.prefs.crtThemeEnabled;
    let curCalm = this.opts.prefs.calmScreen;
    let curSpeed: 1 | 2 = this.opts.settings.animationSpeed;
    let curIntent = this.opts.settings.showIntentArrows;
    let curLethal = this.opts.prefs.showLethalWarnings;
    let curSound = this.opts.settings.soundEnabled;
    let curVol = this.opts.settings.soundVolume;
    let resetArmed = false;

    const pushState = (): void => {
      this.opts.onUpdate({
        narrativeTone: curTone,
        crtScanlines: curScanlines,
        crtThemeEnabled: curCrtTheme,
        calmScreen: curCalm,
        animationSpeed: curSpeed,
        showIntentArrows: curIntent,
        showLethalWarnings: curLethal,
        soundEnabled: curSound,
        soundVolume: curVol,
      });
    };

    const overlay = document.createElement('div');
    overlay.className = 'tfc-modal-backdrop';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Sistem ve Ayarlar');

    const card = document.createElement('div');
    card.className = 'tfc-modal-card sucs-settings-card';

    const header = document.createElement('div');
    header.className = 'tfc-modal-header';
    const titleWrap = document.createElement('div');
    titleWrap.innerHTML =
      '<h2>Sistem & Ayarlar Paneli</h2>' +
      '<p>Anında geçerli ayarlar (maç verisi korunur). Çift tonlu anlatıyı canlı test et.</p>';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tfc-btn';
    closeBtn.textContent = '✕ Kapat [Esc]';
    closeBtn.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      this.close();
    });
    header.append(titleWrap, closeBtn);

    // =========================================================================
    // BLOK 1 — Ton & Atmosfer (+ Canlı Piyon Repliği Önizlemesi)
    // =========================================================================
    const block1 = document.createElement('div');
    block1.className = 'sucs-settings-block';
    block1.innerHTML = '<h3>Blok 1 · Ton & Atmosfer</h3>';

    const toneRow = document.createElement('div');
    toneRow.className = 'tfc-field-row';
    const toneBtnUnf = document.createElement('button');
    toneBtnUnf.type = 'button';
    toneBtnUnf.className = 'tfc-btn';
    toneBtnUnf.textContent = 'Filtresiz S.U.C.S.';
    const toneBtnPol = document.createElement('button');
    toneBtnPol.type = 'button';
    toneBtnPol.className = 'tfc-btn';
    toneBtnPol.textContent = 'Efendi Mod';
    const previewQuoteEl = document.createElement('div');
    previewQuoteEl.className = 'sucs-quote-preview';

    const syncToneUi = (): void => {
      toneBtnUnf.classList.toggle('is-active', curTone === 'unfiltered');
      toneBtnPol.classList.toggle('is-active', curTone === 'polite');
      const q = getPieceQuote('PAWN', 'DISOBEY', curTone, 'settings-preview') ?? '';
      previewQuoteEl.textContent = `PİYON-01 Önizleme: "${q}"`;
    };
    toneBtnUnf.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      curTone = 'unfiltered';
      syncToneUi();
      pushState();
    });
    toneBtnPol.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      curTone = 'polite';
      syncToneUi();
      pushState();
    });
    syncToneUi();

    const toneGrp = document.createElement('div');
    toneGrp.className = 'tfc-btn-group';
    toneGrp.append(toneBtnUnf, toneBtnPol);
    const toneLbl = document.createElement('label');
    toneLbl.textContent = 'Anlatı Dili';
    toneRow.append(toneLbl, toneGrp);

    // CRT Scanlines (Kapalı / Hafif / Retro)
    const scanRow = document.createElement('div');
    scanRow.className = 'tfc-field-row';
    scanRow.innerHTML = '<label>CRT Tarama Çizgileri</label>';
    const scanGrp = document.createElement('div');
    scanGrp.className = 'tfc-btn-group';
    const scanBtns: Partial<Record<CrtScanlineMode, HTMLButtonElement>> = {};
    const scanLabels: ReadonlyArray<{ mode: CrtScanlineMode; label: string }> = [
      { mode: 'off', label: 'Kapalı' },
      { mode: 'light', label: 'Hafif' },
      { mode: 'retro', label: 'Retro' },
    ];
    for (const s of scanLabels) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tfc-btn' + (curScanlines === s.mode ? ' is-active' : '');
      b.textContent = s.label;
      b.addEventListener('click', () => {
        this.opts.onPlayClickSfx();
        curScanlines = s.mode;
        (['off', 'light', 'retro'] as CrtScanlineMode[]).forEach((m) =>
          scanBtns[m]?.classList.toggle('is-active', m === curScanlines),
        );
        pushState();
      });
      scanBtns[s.mode] = b;
      scanGrp.appendChild(b);
    }
    scanRow.appendChild(scanGrp);

    // Perde 4 CRT Teması (Kilidi açılınca aktif)
    const crtThemeRow = document.createElement('label');
    crtThemeRow.className = 'tfc-checkbox-row';
    const crtThemeCheck = document.createElement('input');
    crtThemeCheck.type = 'checkbox';
    crtThemeCheck.checked = curCrtTheme;
    crtThemeCheck.disabled = !this.opts.prefs.crtThemeUnlocked;
    crtThemeCheck.addEventListener('change', () => {
      this.opts.onPlayClickSfx();
      curCrtTheme = crtThemeCheck.checked;
      pushState();
    });
    const crtSpan = document.createElement('span');
    crtSpan.textContent = this.opts.prefs.crtThemeUnlocked
      ? 'Perde 4 CRT Yeşil Fosfor Teması (Aktif edilebilir)'
      : 'Perde 4 CRT Teması (Kilitli — 0x00_ÇEKİRDEK tamamlanınca açılır)';
    crtThemeRow.append(crtThemeCheck, crtSpan);

    // Sakin Ekran Erişilebilirlik Anahtarı
    const calmRow = document.createElement('label');
    calmRow.className = 'tfc-checkbox-row';
    const calmCheck = document.createElement('input');
    calmCheck.type = 'checkbox';
    calmCheck.checked = curCalm;
    calmCheck.addEventListener('change', () => {
      this.opts.onPlayClickSfx();
      curCalm = calmCheck.checked;
      pushState();
    });
    const calmSpan = document.createElement('span');
    calmSpan.textContent = 'Sakin Ekran (Sarsıntıyı %80 kısar, tam ekran flaş ve CRT glitch kapatır)';
    calmRow.append(calmCheck, calmSpan);

    block1.append(toneRow, previewQuoteEl, scanRow, crtThemeRow, calmRow);

    // =========================================================================
    // BLOK 2 — Oynanış (Animasyon Hızı 1x/2x, Niyet Okları, Ölümcül Uyarı)
    // =========================================================================
    const block2 = document.createElement('div');
    block2.className = 'sucs-settings-block';
    block2.innerHTML = '<h3>Blok 2 · Oynanış</h3>';

    const spdRow = document.createElement('div');
    spdRow.className = 'tfc-field-row';
    spdRow.innerHTML = '<label>Animasyon Hızı</label>';
    const spdGrp = document.createElement('div');
    spdGrp.className = 'tfc-btn-group';
    const spd1 = document.createElement('button');
    spd1.type = 'button';
    spd1.className = 'tfc-btn' + (curSpeed === 1 ? ' is-active' : '');
    spd1.textContent = '1x Normal';
    const spd2 = document.createElement('button');
    spd2.type = 'button';
    spd2.className = 'tfc-btn' + (curSpeed === 2 ? ' is-active' : '');
    spd2.textContent = '2x Hızlı (%45 kısa)';
    spd1.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      curSpeed = 1;
      spd1.classList.add('is-active');
      spd2.classList.remove('is-active');
      pushState();
    });
    spd2.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      curSpeed = 2;
      spd2.classList.add('is-active');
      spd1.classList.remove('is-active');
      pushState();
    });
    spdGrp.append(spd1, spd2);
    spdRow.appendChild(spdGrp);

    const intentRow = document.createElement('label');
    intentRow.className = 'tfc-checkbox-row';
    const intentCheck = document.createElement('input');
    intentCheck.type = 'checkbox';
    intentCheck.checked = curIntent;
    intentCheck.addEventListener('change', () => {
      this.opts.onPlayClickSfx();
      curIntent = intentCheck.checked;
      pushState();
    });
    const intentSpan = document.createElement('span');
    intentSpan.textContent = 'Düşman Niyet Okları [I]';
    intentRow.append(intentCheck, intentSpan);

    const lethalRow = document.createElement('label');
    lethalRow.className = 'tfc-checkbox-row';
    const lethalCheck = document.createElement('input');
    lethalCheck.type = 'checkbox';
    lethalCheck.checked = curLethal;
    lethalCheck.addEventListener('change', () => {
      this.opts.onPlayClickSfx();
      curLethal = lethalCheck.checked;
      pushState();
    });
    const lethalSpan = document.createElement('span');
    lethalSpan.textContent = 'Ölümcül Hamle Kafatası Uyarıları';
    lethalRow.append(lethalCheck, lethalSpan);

    block2.append(spdRow, intentRow, lethalRow);

    // =========================================================================
    // BLOK 3 — Ses & Veri (SFX kaydırıcı bırakınca test tıkı + JSON + Sıfırla)
    // =========================================================================
    const block3 = document.createElement('div');
    block3.className = 'sucs-settings-block';
    block3.innerHTML = '<h3>Blok 3 · Ses & Kayıt Verisi</h3>';

    const volRow = document.createElement('div');
    volRow.className = 'tfc-field-row';
    const volLbl = document.createElement('label');
    volLbl.textContent = `Web Audio SFX (%${Math.round(curVol * 100)})`;
    const volSlider = document.createElement('input');
    volSlider.type = 'range';
    volSlider.min = '0';
    volSlider.max = '100';
    volSlider.value = String(Math.round(curVol * 100));
    volSlider.addEventListener('input', () => {
      curVol = Number(volSlider.value) / 100;
      if (curVol > 0) curSound = true;
      volLbl.textContent = `Web Audio SFX (%${Math.round(curVol * 100)})`;
      pushState();
    });
    // Bırakınca test tıklaması çalar
    volSlider.addEventListener('change', () => {
      this.opts.onPlayTestSfx();
    });
    volRow.append(volLbl, volSlider);

    const soundCheckRow = document.createElement('label');
    soundCheckRow.className = 'tfc-checkbox-row';
    const soundCheck = document.createElement('input');
    soundCheck.type = 'checkbox';
    soundCheck.checked = curSound;
    soundCheck.addEventListener('change', () => {
      curSound = soundCheck.checked;
      pushState();
      if (curSound) this.opts.onPlayTestSfx();
    });
    const soundSpan = document.createElement('span');
    soundSpan.textContent = 'Ses Efektleri Açık [M]';
    soundCheckRow.append(soundCheck, soundSpan);

    const jsonStatus = document.createElement('div');
    jsonStatus.className = 'tfc-status-banner';

    const jsonArea = document.createElement('textarea');
    jsonArea.className = 'tfc-code-textarea';
    jsonArea.rows = 3;
    jsonArea.placeholder = 'Dışa aktarılan JSON burada görünür; başka cihazdan aktarmak için yapıştırıp İçe Aktar’a bas...';

    const dataBtns = document.createElement('div');
    dataBtns.className = 'tfc-btn-group';
    const expBtn = document.createElement('button');
    expBtn.type = 'button';
    expBtn.className = 'tfc-btn is-gold';
    expBtn.textContent = 'JSON Dışa Aktar';
    expBtn.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      const payload = this.opts.exportJson();
      jsonArea.value = payload;
      jsonArea.select();
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
        void navigator.clipboard.writeText(payload).catch(() => undefined);
      }
      jsonStatus.textContent = `Kayıt dışa aktarıldı (${payload.length} bayt).`;
      jsonStatus.className = 'tfc-status-banner';
    });

    const impBtn = document.createElement('button');
    impBtn.type = 'button';
    impBtn.className = 'tfc-btn is-primary';
    impBtn.textContent = 'JSON İçe Aktar';
    impBtn.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      const res = this.opts.importJson(jsonArea.value);
      if (res.ok) {
        jsonStatus.textContent = 'Kayıt başarıyla içe aktarıldı ve doğrulandı.';
        jsonStatus.className = 'tfc-status-banner';
        this.close();
      } else {
        jsonStatus.textContent = res.error ?? 'JSON okunamadı.';
        jsonStatus.className = 'tfc-status-banner is-error';
      }
    });

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'tfc-btn is-danger';
    resetBtn.textContent = 'İlerlemeyi Sıfırla';
    resetBtn.addEventListener('click', () => {
      this.opts.onPlayClickSfx();
      if (!resetArmed) {
        resetArmed = true;
        resetBtn.textContent = 'EMİN MİSİN? TEKRAR TIKLA';
        jsonStatus.textContent = 'Dikkat: Tüm sefer ve kilit verileri silinecek!';
        jsonStatus.className = 'tfc-status-banner is-warn';
        return;
      }
      this.opts.onResetAllProgress();
      this.close();
    });
    dataBtns.append(expBtn, impBtn, resetBtn);

    const jsonDrawer = document.createElement('details');
    jsonDrawer.className = 'sucs-paste-drawer';
    const jsonSummary = document.createElement('summary');
    jsonSummary.textContent = 'Gelişmiş: JSON Kayıt Yedeği (Dışa / İçe Aktar)';
    jsonDrawer.append(jsonSummary, jsonArea);

    expBtn.addEventListener('click', () => {
      jsonDrawer.open = true;
    });

    block3.append(volRow, soundCheckRow, dataBtns, jsonDrawer, jsonStatus);

    card.append(header, block1, block2, block3);
    overlay.appendChild(card);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    parent.appendChild(overlay);
    this.overlayEl = overlay;
  }

  public close(): void {
    if (this.overlayEl !== null) {
      this.overlayEl.remove();
      this.overlayEl = null;
      this.opts.onClose?.();
    }
  }
}
