import { nextRng, seedToRngState } from '../engine/prng';

export type SfxKind =
  | 'move'
  | 'slide'
  | 'capture'
  | 'shieldBreak'
  | 'pitFall'
  | 'burn'
  | 'ignite'
  | 'extinguish'
  | 'freeze'
  | 'push'
  | 'wallDestroy'
  | 'alert'
  | 'spawn'
  | 'promote'
  | 'turnChange'
  | 'victory'
  | 'defeat'
  | 'uiSelect'
  | 'uiInvalid'
  | 'menuHover'
  | 'menuClick'
  | 'crtBoot'
  | 'typewriterBlip'
  | 'hitStopPunch'
  | 'killcamDrop'
  | 'roomCollapse'
  | 'roomDrop'
  | 'remoteSignal'
  | 'plateClick'
  | 'arrowShot'
  | 'gasBlast'
  | 'tileCollapse'
  | 'spikeTelegraph'
  | 'spikeStrike'
  | 'faithUltimate'
  | 'madnessUltimate'
  | 'chimeraEvolve'
  | 'miasmaChoke'
  | 'disobey'
  | 'breakdown'
  | 'hallucinationDispel';

export interface SfxPlayer {
  play(kind: SfxKind): void;
  unlock(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
}

type AudioContextCtor = new () => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  if (typeof globalThis === 'undefined') return null;
  const g = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * Generates deterministic mono white-noise samples in [-1, 1] using mulberry32 (no Math.random).
 */
export function generateDeterministicNoiseSamples(length: number, seed = 'tfc-sfx-noise'): Float32Array {
  const samples = new Float32Array(length);
  let rng = seedToRngState(seed);
  for (let i = 0; i < length; i++) {
    const step = nextRng(rng);
    rng = step.nextState;
    samples[i] = step.value * 2 - 1;
  }
  return samples;
}

/**
 * Pure Web Audio API procedural sound synthesizer (offline-first, zero external audio assets).
 * Gracefully no-ops in headless / non-browser environments.
 */
export class SynthSfx implements SfxPlayer {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private volume = 0.65;

  public constructor(initialVolume = 0.65, initiallyMuted = false) {
    this.volume = clampVolume(initialVolume);
    this.muted = initiallyMuted;
  }

  public unlock(): void {
    const ctx = this.ensureContext();
    if (ctx !== null && ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // Ignore autoplay rejection until next user gesture
      });
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    this.syncMasterGain();
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public setVolume(volume: number): void {
    this.volume = clampVolume(volume);
    this.syncMasterGain();
  }

  public getVolume(): number {
    return this.volume;
  }

  /**
   * Plays a typewriter telemetry blip every 3rd non-whitespace character (15 ms).
   */
  public playTypewriterChar(charIndex: number): void {
    if (charIndex % 3 !== 0) return;
    this.play('typewriterBlip');
  }

  public play(kind: SfxKind): void {
    if (this.muted || this.volume <= 0.001) return;
    const ctx = this.ensureContext();
    const out = this.masterGain;
    if (ctx === null || out === null) return;

    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // Autoplay gated until gesture
      });
    }

    const now = ctx.currentTime;

    switch (kind) {
      case 'menuHover':
        // Kısa kare dalga röle tıklaması (620Hz -> 880Hz, gain 0.06, 25ms)
        this.playTone(ctx, out, 'square', 620, 880, now, 0.025, 0.06);
        break;

      case 'menuClick':
        this.playTone(ctx, out, 'square', 680, 960, now, 0.028, 0.085);
        this.playTone(ctx, out, 'triangle', 320, 440, now, 0.025, 0.05);
        break;

      case 'crtBoot':
        // Bant geçiren gürültü taraması (1200Hz -> 300Hz) + 60Hz hum sönümü (110ms)
        this.playSweptFilteredNoise(ctx, out, 'bandpass', 1200, 300, 2.2, now, 0.11, 0.24);
        this.playTone(ctx, out, 'sine', 60, 58, now, 0.11, 0.16);
        break;

      case 'typewriterBlip':
        // Kısa sinüs-kare daktilo blipi (920Hz, gain 0.04, 15ms)
        this.playTone(ctx, out, 'sine', 920, 920, now, 0.015, 0.04);
        this.playTone(ctx, out, 'square', 1840, 1480, now, 0.012, 0.015);
        break;

      case 'hitStopPunch':
        this.playTone(ctx, out, 'square', 110, 48, now, 0.055, 0.2);
        this.playFilteredNoise(ctx, out, 'lowpass', 480, 1.0, now, 0.05, 0.18);
        break;

      case 'killcamDrop':
        // Şah düşüşü ağır CRT güç kesimi + derin çan darbesi
        this.playTone(ctx, out, 'sawtooth', 165, 36, now, 0.34, 0.3);
        this.playSweptFilteredNoise(ctx, out, 'bandpass', 2400, 180, 2.8, now, 0.32, 0.22);
        this.playTone(ctx, out, 'triangle', 110, 52, now + 0.04, 0.28, 0.24);
        break;

      case 'roomCollapse':
        this.playFilteredNoise(ctx, out, 'lowpass', 620, 1.2, now, 0.16, 0.22);
        this.playTone(ctx, out, 'triangle', 190, 82, now, 0.15, 0.18);
        break;

      case 'roomDrop':
        this.playTone(ctx, out, 'triangle', 260, 140, now, 0.14, 0.2);
        this.playFilteredNoise(ctx, out, 'bandpass', 920, 1.5, now + 0.02, 0.12, 0.16);
        break;

      case 'remoteSignal':
        this.playTone(ctx, out, 'sine', 780, 980, now, 0.09, 0.12);
        break;

      case 'move':
        // Crisp retro stone-piece clack (square micro-blip + wooden triangle body)
        this.playTone(ctx, out, 'square', 310, 185, now, 0.032, 0.12);
        this.playTone(ctx, out, 'triangle', 220, 138, now, 0.075, 0.34);
        this.playTone(ctx, out, 'sine', 460, 320, now + 0.01, 0.04, 0.12);
        break;

      case 'slide':
        this.playFilteredNoise(ctx, out, 'bandpass', 2550, 3.4, now, 0.18, 0.28);
        this.playTone(ctx, out, 'triangle', 980, 1560, now, 0.15, 0.13);
        break;

      case 'capture':
        // Crunchy 16-bit tactical impact (sub drop + punchy square hit + filtered shatter noise)
        this.playTone(ctx, out, 'square', 280, 72, now, 0.09, 0.24);
        this.playTone(ctx, out, 'sawtooth', 180, 52, now, 0.15, 0.36);
        this.playFilteredNoise(ctx, out, 'lowpass', 1050, 1.1, now, 0.12, 0.36);
        this.playTone(ctx, out, 'triangle', 360, 110, now + 0.02, 0.09, 0.22);
        break;

      case 'shieldBreak':
        // Crystalline chiptune glass/aegis shatter
        this.playTone(ctx, out, 'square', 1320, 440, now, 0.07, 0.14);
        this.playTone(ctx, out, 'triangle', 1240, 420, now, 0.16, 0.26);
        this.playTone(ctx, out, 'sine', 1860, 2520, now + 0.02, 0.12, 0.2);
        this.playFilteredNoise(ctx, out, 'highpass', 2900, 1.5, now, 0.15, 0.3);
        break;

      case 'pitFall':
        this.playTone(ctx, out, 'sine', 420, 72, now, 0.28, 0.32);
        this.playTone(ctx, out, 'triangle', 110, 48, now + 0.22, 0.12, 0.36);
        break;

      case 'burn':
        this.playFilteredNoise(ctx, out, 'bandpass', 1100, 1.4, now, 0.2, 0.32);
        this.playTone(ctx, out, 'sawtooth', 160, 90, now, 0.15, 0.2);
        break;

      case 'ignite':
        this.playFilteredNoise(ctx, out, 'bandpass', 1450, 1.8, now, 0.16, 0.26);
        this.playTone(ctx, out, 'triangle', 260, 420, now, 0.1, 0.14);
        break;

      case 'extinguish':
        this.playFilteredNoise(ctx, out, 'highpass', 3200, 0.8, now, 0.14, 0.16);
        break;

      case 'freeze':
        this.playTone(ctx, out, 'sine', 1046.5, 1046.5, now, 0.16, 0.2);
        this.playTone(ctx, out, 'sine', 1318.5, 1318.5, now + 0.035, 0.18, 0.18);
        this.playTone(ctx, out, 'sine', 1568.0, 1568.0, now + 0.07, 0.2, 0.15);
        break;

      case 'push':
        this.playTone(ctx, out, 'triangle', 280, 105, now, 0.11, 0.34);
        this.playFilteredNoise(ctx, out, 'bandpass', 720, 1.6, now, 0.1, 0.22);
        break;

      case 'wallDestroy':
        this.playFilteredNoise(ctx, out, 'lowpass', 620, 0.9, now, 0.26, 0.48);
        this.playTone(ctx, out, 'sawtooth', 130, 42, now, 0.24, 0.38);
        this.playTone(ctx, out, 'square', 85, 38, now + 0.05, 0.16, 0.2);
        break;

      case 'alert':
        this.playTone(ctx, out, 'square', 660, 660, now, 0.065, 0.16);
        this.playTone(ctx, out, 'square', 880, 880, now + 0.08, 0.09, 0.18);
        break;

      case 'spawn':
        this.playTone(ctx, out, 'sawtooth', 146.8, 220, now, 0.24, 0.18);
        this.playTone(ctx, out, 'triangle', 293.6, 329.6, now + 0.06, 0.22, 0.16);
        break;

      case 'promote':
        this.playTone(ctx, out, 'triangle', 523.25, 523.25, now, 0.09, 0.22);
        this.playTone(ctx, out, 'triangle', 659.25, 659.25, now + 0.07, 0.09, 0.22);
        this.playTone(ctx, out, 'triangle', 783.99, 783.99, now + 0.14, 0.12, 0.24);
        this.playTone(ctx, out, 'sine', 1046.5, 1046.5, now + 0.21, 0.2, 0.24);
        break;

      case 'turnChange':
        this.playTone(ctx, out, 'sine', 420, 520, now, 0.06, 0.1);
        break;

      case 'victory':
        this.playTone(ctx, out, 'triangle', 523.25, 523.25, now, 0.15, 0.24);
        this.playTone(ctx, out, 'triangle', 659.25, 659.25, now + 0.11, 0.15, 0.24);
        this.playTone(ctx, out, 'triangle', 783.99, 783.99, now + 0.22, 0.18, 0.26);
        this.playTone(ctx, out, 'sine', 1046.5, 1046.5, now + 0.34, 0.35, 0.28);
        break;

      case 'defeat':
        this.playTone(ctx, out, 'sawtooth', 311.1, 293.6, now, 0.18, 0.18);
        this.playTone(ctx, out, 'sawtooth', 261.6, 233.1, now + 0.18, 0.22, 0.18);
        this.playTone(ctx, out, 'triangle', 196.0, 146.8, now + 0.38, 0.35, 0.24);
        break;

      case 'uiSelect':
        this.playTone(ctx, out, 'sine', 540, 620, now, 0.04, 0.12);
        break;

      case 'uiInvalid':
        this.playTone(ctx, out, 'sawtooth', 165, 130, now, 0.09, 0.14);
        break;

      case 'plateClick':
        // Düşük taş tıkı (180Hz pulse + mekanik klik, 45ms)
        this.playTone(ctx, out, 'triangle', 180, 110, now, 0.045, 0.24);
        this.playTone(ctx, out, 'square', 640, 290, now, 0.025, 0.14);
        break;

      case 'arrowShot':
        // Yüksek frekans gürültü whoosh (2800Hz -> 700Hz) + metalik çınlama (130ms)
        this.playSweptFilteredNoise(ctx, out, 'bandpass', 2800, 700, 2.8, now, 0.13, 0.28);
        this.playTone(ctx, out, 'triangle', 1560, 680, now + 0.01, 0.09, 0.16);
        break;

      case 'gasBlast': {
        // 45 ms sessiz içe çekme -> derin bass düşüş (110Hz -> 28Hz) + alçak geçiren beyaz gürültü (320ms)
        const boomAt = now + 0.045;
        this.playTone(ctx, out, 'sawtooth', 110, 28, boomAt, 0.32, 0.44);
        this.playFilteredNoise(ctx, out, 'lowpass', 520, 0.85, boomAt, 0.32, 0.52);
        this.playTone(ctx, out, 'square', 165, 42, boomAt + 0.02, 0.2, 0.22);
        break;
      }

      case 'tileCollapse':
        // Granüler düşük frekans taş ufalanma gürültüsü (180ms)
        this.playFilteredNoise(ctx, out, 'lowpass', 720, 1.2, now, 0.07, 0.34);
        this.playFilteredNoise(ctx, out, 'lowpass', 580, 1.4, now + 0.055, 0.075, 0.3);
        this.playFilteredNoise(ctx, out, 'lowpass', 460, 1.2, now + 0.11, 0.07, 0.24);
        this.playTone(ctx, out, 'triangle', 160, 52, now, 0.18, 0.28);
        break;

      case 'spikeTelegraph':
        this.playTone(ctx, out, 'square', 920, 1140, now, 0.045, 0.12);
        this.playTone(ctx, out, 'triangle', 520, 640, now + 0.04, 0.05, 0.12);
        break;

      case 'spikeStrike':
        // Keskin metalik "şink" (1800Hz + highpass, 90ms)
        this.playTone(ctx, out, 'square', 1800, 1280, now, 0.09, 0.18);
        this.playTone(ctx, out, 'sawtooth', 940, 320, now, 0.09, 0.22);
        this.playFilteredNoise(ctx, out, 'highpass', 2600, 1.9, now, 0.09, 0.26);
        break;

      case 'faithUltimate':
        // 3 sesli ney/üfleme benzeri yumuşak triangle arpej + yüksek tılsım çanı + susturma alçak sönüm (420ms)
        this.playTone(ctx, out, 'triangle', 523.25, 523.25, now, 0.16, 0.22);
        this.playTone(ctx, out, 'triangle', 659.25, 659.25, now + 0.07, 0.16, 0.22);
        this.playTone(ctx, out, 'triangle', 783.99, 783.99, now + 0.14, 0.22, 0.24);
        this.playTone(ctx, out, 'sine', 1568.0, 1568.0, now + 0.2, 0.22, 0.18);
        this.playSweptFilteredNoise(ctx, out, 'lowpass', 2800, 380, 1.6, now + 0.18, 0.24, 0.18);
        break;

      case 'madnessUltimate':
        // Çift vuruşlu deri davul (85Hz -> 42Hz) + bozuk sawtooth tritone (360ms)
        this.playTone(ctx, out, 'triangle', 85, 42, now, 0.095, 0.34);
        this.playTone(ctx, out, 'triangle', 85, 42, now + 0.1, 0.12, 0.36);
        this.playTone(ctx, out, 'sawtooth', 185.0, 174.6, now + 0.02, 0.32, 0.24);
        this.playTone(ctx, out, 'sawtooth', 261.63, 277.18, now + 0.06, 0.28, 0.22);
        this.playTone(ctx, out, 'square', 369.99, 311.13, now + 0.11, 0.24, 0.16);
        this.playFilteredNoise(ctx, out, 'bandpass', 1400, 2.2, now + 0.04, 0.22, 0.18);
        break;

      case 'chimeraEvolve':
        // Düşük frekans organik hırıltı (AM modüleli sawtooth 95Hz) + yukarı kayan sentetik mutasyon akoru (340ms)
        this.playAmGrowl(ctx, out, 95, 14, now, 0.26, 0.3);
        this.playFilteredNoise(ctx, out, 'lowpass', 480, 1.4, now, 0.2, 0.22);
        this.playTone(ctx, out, 'triangle', 220, 660, now + 0.08, 0.26, 0.22);
        this.playTone(ctx, out, 'sine', 330, 880, now + 0.12, 0.22, 0.18);
        break;

      case 'miasmaChoke':
        this.playFilteredNoise(ctx, out, 'bandpass', 950, 2.5, now, 0.18, 0.24);
        this.playTone(ctx, out, 'triangle', 260, 140, now, 0.14, 0.2);
        break;

      case 'disobey':
        // İki alçalan dissonant kare nota (240Hz -> 175Hz), sert kesim (140ms)
        this.playTone(ctx, out, 'square', 240, 232, now, 0.065, 0.18);
        this.playTone(ctx, out, 'square', 175, 168, now + 0.07, 0.07, 0.18);
        break;

      case 'breakdown':
        this.playTone(ctx, out, 'sawtooth', 440, 140, now, 0.24, 0.24);
        this.playTone(ctx, out, 'square', 311.1, 110, now + 0.06, 0.22, 0.18);
        break;

      case 'hallucinationDispel':
        this.playFilteredNoise(ctx, out, 'highpass', 2600, 1.2, now, 0.16, 0.18);
        this.playTone(ctx, out, 'sine', 960, 420, now, 0.15, 0.14);
        break;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx !== null) return this.ctx;
    const Ctor = resolveAudioContextCtor();
    if (Ctor === null) return null;

    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : this.volume;
      master.connect(ctx.destination);

      const length = Math.max(1, Math.floor(ctx.sampleRate * 0.5));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const channelData = buffer.getChannelData(0);
      const samples = generateDeterministicNoiseSamples(length);
      channelData.set(samples);

      this.ctx = ctx;
      this.masterGain = master;
      this.noiseBuffer = buffer;
      return ctx;
    } catch {
      return null;
    }
  }

  private syncMasterGain(): void {
    if (this.masterGain !== null && this.ctx !== null) {
      this.masterGain.gain.setTargetAtTime(
        this.muted ? 0 : this.volume,
        this.ctx.currentTime,
        0.015,
      );
    }
  }

  private playTone(
    ctx: AudioContext,
    dest: AudioNode,
    type: OscillatorType,
    startFreq: number,
    endFreq: number,
    startTime: number,
    duration: number,
    peakGain: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, startFreq), startTime);
    if (endFreq !== startFreq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), startTime + duration);
    }

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + Math.min(0.012, duration * 0.25));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(dest);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.02);
  }

  private playAmGrowl(
    ctx: AudioContext,
    dest: AudioNode,
    carrierHz: number,
    modHz: number,
    startTime: number,
    duration: number,
    peakGain: number,
  ): void {
    const carrier = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const amGain = ctx.createGain();

    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(carrierHz, startTime);
    carrier.frequency.exponentialRampToValueAtTime(Math.max(24, carrierHz * 0.68), startTime + duration);

    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(modHz, startTime);
    lfoGain.gain.setValueAtTime(peakGain * 0.45, startTime);

    amGain.gain.setValueAtTime(0.0001, startTime);
    amGain.gain.linearRampToValueAtTime(peakGain * 0.65, startTime + 0.025);
    amGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    lfo.connect(lfoGain);
    lfoGain.connect(amGain.gain);
    carrier.connect(amGain);
    amGain.connect(dest);

    carrier.start(startTime);
    lfo.start(startTime);
    carrier.stop(startTime + duration + 0.02);
    lfo.stop(startTime + duration + 0.02);
  }

  private playFilteredNoise(
    ctx: AudioContext,
    dest: AudioNode,
    filterType: BiquadFilterType,
    frequency: number,
    q: number,
    startTime: number,
    duration: number,
    peakGain: number,
  ): void {
    if (this.noiseBuffer === null) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, startTime);
    filter.Q.setValueAtTime(q, startTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + Math.min(0.015, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start(startTime);
    src.stop(startTime + duration + 0.02);
  }

  private playSweptFilteredNoise(
    ctx: AudioContext,
    dest: AudioNode,
    filterType: BiquadFilterType,
    startFreq: number,
    endFreq: number,
    q: number,
    startTime: number,
    duration: number,
    peakGain: number,
  ): void {
    if (this.noiseBuffer === null) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(Math.max(40, startFreq), startTime);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, endFreq), startTime + duration);
    filter.Q.setValueAtTime(q, startTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(peakGain, startTime + Math.min(0.015, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(dest);
    src.start(startTime);
    src.stop(startTime + duration + 0.02);
  }
}

function clampVolume(v: number): number {
  if (!Number.isFinite(v)) return 0.65;
  return Math.max(0, Math.min(1, v));
}
