// プロシージャル効果音（WebAudio 合成・外部音源ファイルなし）。ミュート状態は localStorage に永続化。
// autoplay ポリシー対策として、AudioContext は初回ユーザー操作で生成/resume する（E8）。
// 生成に失敗する環境（WebAudio 非対応）では全メソッドが安全に no-op になる。
const MUTE_KEY = 'sb_muted';

// ループBGMの和音進行（Am–F–C–G 相当・落ち着いた3声パッド。各要素は [低音, 中音, 高音] Hz）。
const BGM_CHORDS: [number, number, number][] = [
  [110.0, 164.81, 220.0], // Am
  [87.31, 130.81, 174.61], // F
  [65.41, 130.81, 196.0], // C
  [98.0, 146.83, 196.0], // G
];

export class AudioKit {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted: boolean;
  private noiseBuf: AudioBuffer | null = null;
  // ループBGM（Q4・プロシージャル）: パッド3声 + まばらなアルペジオ。bgmGain→master でミュート連動。
  private bgmGain: GainNode | null = null;
  private bgmOscs: OscillatorNode[] = [];
  private bgmTimer = 0;
  private bgmStep = 0;
  private bgmOn = false;

  constructor() {
    this.muted = localStorage.getItem(MUTE_KEY) === '1';
    // 初回のユーザー操作で解錠（autoplay 制限の回避）。一度だけ。BGM が要求済みなら解錠時に鳴らし始める。
    const unlock = (): void => {
      this.ensure();
      void this.ctx?.resume();
      if (this.bgmOn) this.bgmStart();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  isMuted(): boolean {
    return this.muted;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.9;
    return this.muted;
  }

  dispose(): void {
    this.bgmStop();
    try {
      void this.ctx?.close();
    } catch {
      /* noop */
    }
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
  }

  // ---- ループBGM + 環境音（Q4・E3: autoplay 解錠と統合・タブ非表示で停止・ミュート連動） ----

  /** BGM を開始（未解錠なら bgmOn を立て、初回操作の解錠時に鳴り始める）。二重起動しない。 */
  bgmStart(): void {
    this.bgmOn = true;
    if (this.bgmOscs.length > 0) return; // 既に鳴っている
    if (!this.ensure()) return;
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(this.master!);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 760;
    filt.Q.value = 0.5;
    filt.connect(g);
    this.bgmGain = g;
    const chord = BGM_CHORDS[0]!;
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.value = chord[i]!;
      const og = ctx.createGain();
      og.gain.value = i === 0 ? 0.16 : 0.1;
      o.connect(og).connect(filt);
      o.start();
      this.bgmOscs.push(o);
    }
    // 静かに立ち上げる（音量控えめ）。ミュート中は 0 のまま。
    g.gain.setTargetAtTime(this.muted ? 0.0001 : 0.14, ctx.currentTime, 1.6);
    this.bgmStep = 0;
    this.bgmTimer = window.setInterval(() => this.bgmTick(), 2600);
    this.bgmTick();
  }

  /** BGM を停止（フェードアウトして発振停止）。 */
  bgmStop(): void {
    this.bgmOn = false;
    if (this.bgmTimer) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = 0;
    }
    const ctx = this.ctx;
    if (ctx && this.bgmGain) this.bgmGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
    const stopAt = ctx ? ctx.currentTime + 0.45 : 0;
    for (const o of this.bgmOscs) {
      try {
        o.stop(stopAt);
      } catch {
        /* noop */
      }
    }
    this.bgmOscs = [];
    this.bgmGain = null;
  }

  /** タブ非表示で BGM/音を止める（E3）。可視復帰で resume。 */
  suspend(): void {
    try {
      void this.ctx?.suspend();
    } catch {
      /* noop */
    }
  }

  resume(): void {
    try {
      void this.ctx?.resume();
    } catch {
      /* noop */
    }
  }

  private bgmTick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.bgmOn || this.bgmOscs.length < 3) return;
    if (typeof document !== 'undefined' && document.hidden) return; // 非表示中は進めない
    const chord = BGM_CHORDS[this.bgmStep % BGM_CHORDS.length]!;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      try {
        this.bgmOscs[i]!.frequency.exponentialRampToValueAtTime(Math.max(1, chord[i]!), t + 1.8);
      } catch {
        /* noop */
      }
    }
    // まばらな環境アルペジオ（和音の高声を1オクターブ上げ、そっと）。ミュート時は live() が止める。
    this.tone(chord[2]! * 2, 1.1, 'sine', 0.045, 0.2);
    if (this.bgmStep % 2 === 1) this.tone(chord[1]! * 2, 0.9, 'sine', 0.035, 0.7);
    this.bgmStep++;
  }

  private ensure(): boolean {
    if (this.ctx) return true;
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.9;
      this.master.connect(this.ctx.destination);
      // 短いホワイトノイズ（tick/whoosh 用）
      const len = Math.floor(this.ctx.sampleRate * 0.4);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.noiseBuf = buf;
      return true;
    } catch {
      this.ctx = null;
      return false;
    }
  }

  private live(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ensure()) return null;
    const ctx = this.ctx!;
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }

  // ---- 合成プリミティブ --------------------------------------------------

  private tone(
    freq: number,
    dur: number,
    type: OscillatorType,
    gain: number,
    delay = 0,
    glideTo?: number,
  ): void {
    const ctx = this.live();
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, gain: number, filterHz: number, delay = 0, q = 1): void {
    const ctx = this.live();
    if (!ctx || !this.master || !this.noiseBuf) return;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = filterHz;
    bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  // ---- ゲームイベント音 --------------------------------------------------

  /** 配札の1枚（軽いトランプ音）。連続配札は index でピッチを僅かに散らす。 */
  deal(index = 0): void {
    this.noise(0.06, 0.28, 2600 + (index % 5) * 120, 0, 1.2);
  }

  /** ツモ（すっと引く軽いスワイプ音）。 */
  draw(): void {
    this.noise(0.16, 0.22, 1800, 0, 0.8);
    this.tone(520, 0.14, 'sine', 0.12, 0.02, 720);
  }

  /** 捨て札（ぱしっと置く音）。 */
  discard(): void {
    this.noise(0.07, 0.3, 2200, 0, 1.4);
    this.tone(220, 0.08, 'triangle', 0.14);
  }

  /** ポン（低く力強い打撃音）。 */
  pon(): void {
    this.tone(140, 0.22, 'square', 0.22, 0, 90);
    this.tone(280, 0.16, 'triangle', 0.16);
    this.noise(0.1, 0.25, 900, 0, 1);
  }

  /** チー（明るい2音）。 */
  chi(): void {
    this.tone(660, 0.14, 'triangle', 0.18);
    this.tone(880, 0.16, 'triangle', 0.16, 0.06);
  }

  /** メルド公開（きらめくアルペジオ）。 */
  meld(): void {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => this.tone(f, 0.2, 'triangle', 0.14, i * 0.05));
  }

  /** 上がり（勝利ジングル）。 */
  win(): void {
    const notes = [523, 659, 784, 1047, 1319];
    notes.forEach((f, i) => this.tone(f, 0.35, 'sawtooth', 0.13, i * 0.09));
    this.tone(262, 0.6, 'sine', 0.12, 0.1);
  }

  /** 手番交代（控えめなブリップ）。 */
  turn(): void {
    this.tone(440, 0.09, 'sine', 0.09, 0, 560);
  }

  /** ボタン押下（クリック）。 */
  click(): void {
    this.tone(760, 0.05, 'square', 0.08, 0, 900);
  }

  /** 付け札成立（軽やかな確定音・上行2音＋ノイズの「かちっ」・Q10）。 */
  attach(): void {
    this.tone(700, 0.1, 'triangle', 0.14);
    this.tone(1050, 0.14, 'triangle', 0.13, 0.05);
    this.noise(0.05, 0.16, 3200, 0, 1.4);
  }

  /** エラー/操作拒否（低い下行のブザー・Q10）。成功音と聴覚で弁別できる。 */
  error(): void {
    this.tone(220, 0.18, 'sawtooth', 0.16, 0, 150);
    this.tone(160, 0.22, 'square', 0.12, 0.04, 110);
  }

  /** 鳴きウィンドウ開始スティンガー（緊張を告げる短い上昇音・Q11）。 */
  claimOpen(): void {
    this.tone(520, 0.12, 'triangle', 0.15, 0, 780);
    this.tone(784, 0.16, 'sine', 0.12, 0.07);
    this.noise(0.12, 0.12, 1400, 0, 0.7);
  }
}
