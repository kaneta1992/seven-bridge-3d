// プール制パーティクル（GPU 1 draw call/種別）。スパーク（加算合成・発光）と紙吹雪（通常合成・重力）の
// 2 プールを、共通の頂点属性レイアウト + 軽量シェーダ（粒子ごとの色/サイズ/アルファ）で駆動する。
// 上限数は QualityTier から与える（E1: モバイルで自動減）。dispose で GPU 資源を解放（E11）。
import * as THREE from 'three';

const VERT = `
  uniform float uScale;
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * (uScale / max(0.001, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - vec2(0.5);
    float r = length(d);
    if (r > 0.5) discard;
    float soft = smoothstep(0.5, 0.0, r);
    gl_FragColor = vec4(vColor, vAlpha * soft);
  }
`;

interface EmitOpts {
  count: number;
  color: [number, number, number] | (() => [number, number, number]);
  speed: number; // 初速の基準（ランダムに ±40%）
  spread: number; // 方向の広がり（0=上方向のみ, 1=全方位）
  size: number; // 粒子サイズ基準
  life: number; // 寿命(秒)
  gravity: number; // 下向き加速度
  drag: number; // 速度減衰(0..1/s)
}

/** 1 プール = 1 Points。固定容量の属性バッファを前詰めで使う（compact 管理）。 */
class Pool {
  readonly points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private cap: number;
  private n = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private alpha: Float32Array;
  // JS 側の物理状態（属性には出さない）
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private size0: Float32Array;

  constructor(cap: number, blending: number, uScale: number) {
    this.cap = cap;
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 3);
    this.size = new Float32Array(cap);
    this.alpha = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.size0 = new Float32Array(cap);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage ?? 35048));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage ?? 35048));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage ?? 35048));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage ?? 35048));
    this.geo.setDrawRange(0, 0);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: uScale } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
  }

  setScale(uScale: number): void {
    this.mat.uniforms.uScale.value = uScale;
  }

  emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    r: number,
    g: number,
    b: number,
    size: number,
    life: number,
    gravity: number,
    drag: number,
  ): void {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.grav[i] = gravity;
    this.drag[i] = drag;
    this.size0[i] = size;
    this.size[i] = size;
    this.alpha[i] = 1;
  }

  /** 物理更新 + 死亡粒子の swap-remove。alive>0 を返す。 */
  update(dt: number): boolean {
    let i = 0;
    while (i < this.n) {
      let l = this.life[i]! - dt;
      if (l <= 0) {
        // swap-remove: 末尾を i へ詰める
        const j = --this.n;
        this.copy(j, i);
        continue;
      }
      this.life[i] = l;
      const dr = Math.max(0, 1 - this.drag[i]! * dt);
      this.vy[i] = this.vy[i]! * dr - this.grav[i]! * dt;
      this.vx[i] = this.vx[i]! * dr;
      this.vz[i] = this.vz[i]! * dr;
      this.pos[i * 3] = this.pos[i * 3]! + this.vx[i]! * dt;
      this.pos[i * 3 + 1] = this.pos[i * 3 + 1]! + this.vy[i]! * dt;
      this.pos[i * 3 + 2] = this.pos[i * 3 + 2]! + this.vz[i]! * dt;
      const t = l / this.maxLife[i]!; // 1→0
      this.alpha[i] = Math.min(1, t * 1.6); // 末期にフェード
      this.size[i] = this.size0[i]! * (0.4 + 0.6 * t); // 徐々に縮む
      i++;
    }
    this.flush();
    return this.n > 0;
  }

  private copy(from: number, to: number): void {
    this.pos[to * 3] = this.pos[from * 3]!;
    this.pos[to * 3 + 1] = this.pos[from * 3 + 1]!;
    this.pos[to * 3 + 2] = this.pos[from * 3 + 2]!;
    this.col[to * 3] = this.col[from * 3]!;
    this.col[to * 3 + 1] = this.col[from * 3 + 1]!;
    this.col[to * 3 + 2] = this.col[from * 3 + 2]!;
    this.size[to] = this.size[from]!;
    this.alpha[to] = this.alpha[from]!;
    this.vx[to] = this.vx[from]!;
    this.vy[to] = this.vy[from]!;
    this.vz[to] = this.vz[from]!;
    this.life[to] = this.life[from]!;
    this.maxLife[to] = this.maxLife[from]!;
    this.grav[to] = this.grav[from]!;
    this.drag[to] = this.drag[from]!;
    this.size0[to] = this.size0[from]!;
  }

  private flush(): void {
    this.geo.setDrawRange(0, this.n);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

export class ParticleSystem {
  private sparks: Pool;
  private confetti: Pool;

  constructor(sparkCap: number, confettiCap: number, uScale: number) {
    this.sparks = new Pool(sparkCap, THREE.AdditiveBlending ?? 2, uScale);
    this.confetti = new Pool(confettiCap, THREE.NormalBlending ?? 1, uScale);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.sparks.points);
    scene.add(this.confetti.points);
  }

  /** パーティクルを選択的 Bloom の対象レイヤへ載せる（発光を滲ませる・契約09項目1/2）。 */
  setBloomLayer(layer: number): void {
    this.sparks.points.layers.enable(layer);
    this.confetti.points.layers.enable(layer);
  }

  setScale(uScale: number): void {
    this.sparks.setScale(uScale);
    this.confetti.setScale(uScale);
  }

  /** 加算合成の発光バースト（メルド公開・ポン・チーの決め演出）。 */
  burst(pos: THREE.Vector3, opts: Partial<EmitOpts> = {}): void {
    const o: EmitOpts = {
      count: 28,
      color: [1, 0.85, 0.4],
      speed: 2.6,
      spread: 1,
      size: 0.09,
      life: 0.7,
      gravity: 1.4,
      drag: 1.1,
      ...opts,
    };
    for (let k = 0; k < o.count; k++) {
      const c = typeof o.color === 'function' ? o.color() : o.color;
      const theta = Math.random() * Math.PI * 2;
      const phi = (1 - Math.random() * o.spread) * (Math.PI / 2); // spread=1 で全半球
      const dirx = Math.cos(theta) * Math.cos(phi);
      const dirz = Math.sin(theta) * Math.cos(phi);
      const diry = Math.sin(phi);
      const sp = o.speed * (0.6 + Math.random() * 0.8);
      this.sparks.emit(
        pos.x,
        pos.y,
        pos.z,
        dirx * sp,
        (diry + 0.4) * sp,
        dirz * sp,
        c[0]!,
        c[1]!,
        c[2]!,
        o.size * (0.6 + Math.random() * 0.9),
        o.life * (0.7 + Math.random() * 0.6),
        o.gravity,
        o.drag,
      );
    }
  }

  /** 通常合成の紙吹雪噴水（上がり・ラウンド終了のセレブレーション）。 */
  confettiFountain(origin: THREE.Vector3, count: number): void {
    const palette: [number, number, number][] = [
      [1.0, 0.28, 0.34],
      [1.0, 0.82, 0.28],
      [0.28, 0.8, 0.5],
      [0.32, 0.62, 1.0],
      [0.85, 0.4, 1.0],
      [1.0, 1.0, 1.0],
    ];
    for (let k = 0; k < count; k++) {
      const c = palette[(Math.random() * palette.length) | 0]!;
      const theta = Math.random() * Math.PI * 2;
      const rad = Math.random() * 0.6;
      const sp = 3.4 + Math.random() * 2.8;
      this.confetti.emit(
        origin.x + Math.cos(theta) * rad,
        origin.y,
        origin.z + Math.sin(theta) * rad,
        Math.cos(theta) * (0.6 + Math.random()),
        sp,
        Math.sin(theta) * (0.6 + Math.random()),
        c[0]!,
        c[1]!,
        c[2]!,
        0.11 + Math.random() * 0.08,
        1.5 + Math.random() * 1.4,
        3.2,
        0.15,
      );
    }
  }

  update(dt: number): boolean {
    const a = this.sparks.update(dt);
    const b = this.confetti.update(dt);
    return a || b;
  }

  dispose(): void {
    this.sparks.dispose();
    this.confetti.dispose();
  }
}
