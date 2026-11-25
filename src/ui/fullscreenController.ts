// src/ui/fullscreenController.ts
// S.U.C.S. — YouTube Tarzı Tam Ekran Yöneticisi (Fullscreen API + WebKit + iOS Safari 100dvh Fallback).

export interface FullscreenControllerOptions {
  targetEl: HTMLElement;
  onChange?: (isFullscreen: boolean, mode: 'native' | 'pseudo' | 'none') => void;
  doc?: DocumentLike;
  nav?: NavigatorLike;
}

export interface DocumentLike {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void> | void;
  webkitExitFullscreen?: () => Promise<void> | void;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  body?: { classList: { toggle: (cls: string, force?: boolean) => void } } | null;
}

export interface NavigatorLike {
  userAgent?: string;
  platform?: string;
  maxTouchPoints?: number;
}

interface FullscreenTargetElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function detectIos(nav?: NavigatorLike): boolean {
  if (nav === undefined) return false;
  const ua = nav.userAgent ?? '';
  const platform = nav.platform ?? '';
  const touch = nav.maxTouchPoints ?? 0;
  return /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touch > 1);
}

/**
 * Masaüstü/Android'de standart Fullscreen API'yi, iOS Safari gibi kısıtlı tarayıcılarda
 * ise `100dvh` sabit pseudo-fullscreen modunu sorunsuz yönetir.
 */
export class FullscreenController {
  private readonly targetEl: FullscreenTargetElement;
  private readonly doc: DocumentLike | null;
  private readonly nav: NavigatorLike | undefined;
  private readonly onChange?: (isFullscreen: boolean, mode: 'native' | 'pseudo' | 'none') => void;
  private pseudoActive = false;
  private lastKnownActive = false;
  private readonly handleFsChange: EventListener;

  public constructor(opts: FullscreenControllerOptions) {
    this.targetEl = opts.targetEl as FullscreenTargetElement;
    this.onChange = opts.onChange;
    this.doc =
      opts.doc ??
      (typeof document !== 'undefined' ? (document as unknown as DocumentLike) : null);
    this.nav =
      opts.nav ??
      (typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorLike) : undefined);

    this.handleFsChange = (): void => {
      const active = this.isFullscreen();
      this.syncClasses(active, this.getMode());
      if (active !== this.lastKnownActive) {
        this.lastKnownActive = active;
        this.onChange?.(active, this.getMode());
      }
    };

    if (this.doc !== null) {
      this.doc.addEventListener('fullscreenchange', this.handleFsChange);
      this.doc.addEventListener('webkitfullscreenchange', this.handleFsChange);
    }
  }

  public supportsNativeFullscreen(): boolean {
    if (this.doc === null || detectIos(this.nav)) return false;
    const enabled =
      this.doc.fullscreenEnabled === true || this.doc.webkitFullscreenEnabled === true;
    const hasReq =
      typeof this.targetEl.requestFullscreen === 'function' ||
      typeof this.targetEl.webkitRequestFullscreen === 'function';
    return enabled && hasReq;
  }

  public isNativeFullscreen(): boolean {
    if (this.doc === null) return false;
    return (
      (this.doc.fullscreenElement ?? null) !== null ||
      (this.doc.webkitFullscreenElement ?? null) !== null
    );
  }

  public isPseudoFullscreen(): boolean {
    return this.pseudoActive;
  }

  public isFullscreen(): boolean {
    return this.isNativeFullscreen() || this.pseudoActive;
  }

  public getMode(): 'native' | 'pseudo' | 'none' {
    if (this.isNativeFullscreen()) return 'native';
    if (this.pseudoActive) return 'pseudo';
    return 'none';
  }

  public async enter(): Promise<boolean> {
    if (this.isFullscreen()) return true;

    if (this.supportsNativeFullscreen()) {
      try {
        const req = this.targetEl.requestFullscreen ?? this.targetEl.webkitRequestFullscreen;
        if (typeof req === 'function') {
          await Promise.resolve(req.call(this.targetEl));
          // Native event may fire asynchronously; sync immediately if element already updated
          const active = this.isNativeFullscreen();
          if (active) {
            this.syncClasses(true, 'native');
            if (!this.lastKnownActive) {
              this.lastKnownActive = true;
              this.onChange?.(true, 'native');
            }
          }
          return true;
        }
      } catch {
        // Native fullscreen blocked (e.g. iframe policy) -> graceful pseudo-fullscreen fallback
      }
    }

    this.pseudoActive = true;
    this.syncClasses(true, 'pseudo');
    if (!this.lastKnownActive) {
      this.lastKnownActive = true;
      this.onChange?.(true, 'pseudo');
    }
    return true;
  }

  public async exit(): Promise<void> {
    if (this.pseudoActive) {
      this.pseudoActive = false;
      this.syncClasses(false, 'none');
      if (this.lastKnownActive) {
        this.lastKnownActive = false;
        this.onChange?.(false, 'none');
      }
      return;
    }

    if (this.isNativeFullscreen() && this.doc !== null) {
      try {
        const exitFn = this.doc.exitFullscreen ?? this.doc.webkitExitFullscreen;
        if (typeof exitFn === 'function') {
          await Promise.resolve(exitFn.call(this.doc));
        }
      } catch {
        // Ignore browser exit errors
      }
      const stillActive = this.isNativeFullscreen();
      if (!stillActive) {
        this.syncClasses(false, 'none');
        if (this.lastKnownActive) {
          this.lastKnownActive = false;
          this.onChange?.(false, 'none');
        }
      }
    }
  }

  public async toggle(): Promise<boolean> {
    if (this.isFullscreen()) {
      await this.exit();
      return false;
    }
    return this.enter();
  }

  public destroy(): void {
    if (this.pseudoActive) {
      this.pseudoActive = false;
      this.syncClasses(false, 'none');
    }
    if (this.doc !== null) {
      this.doc.removeEventListener('fullscreenchange', this.handleFsChange);
      this.doc.removeEventListener('webkitfullscreenchange', this.handleFsChange);
    }
  }

  private syncClasses(active: boolean, mode: 'native' | 'pseudo' | 'none'): void {
    this.targetEl.classList.toggle('is-fullscreen-active', active);
    this.targetEl.classList.toggle('is-pseudo-fullscreen', mode === 'pseudo');
    this.doc?.body?.classList.toggle('is-pseudo-fullscreen-body', mode === 'pseudo');
  }
}
