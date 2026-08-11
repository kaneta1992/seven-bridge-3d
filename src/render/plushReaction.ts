// 契約24: ソファのぬいぐるみ「見つめると反応する」演出。
//
// 対局中の首振りカメラで「ぬいぐるみの方を向き（視線ベクトルと人形頭部方向の角度差が閾値内）かつ
// ズームイン（fov が既定より十分小さい）」を数百ms 注視すると発火する。両個体とも Meshy リグ不可
// （座り姿勢+衣装でポーズ推定失敗）のため、ボーンレスの transform アニメで「こっちに向かって
// エモーションする」を表現する。2体で動きを差別化する:
//   - パンダ: squash&stretch のぷるぷる→ぴょんと2回はねる。
//   - ダルメシアン: カメラへ小さく向き直り、左右に嬉しそうに揺れて（ロール）、1回大きくはねる。
// どちらも終了時は座標・回転・スケールをイージングで元の姿勢へ滑らかに戻す（タイムラインが u=1 で
// ちょうどホームへ収束する設計＝ポップしない）。両者ともハート粒子 + プロシージャル効果音（sfx
// コールバック経由・描画層は音を持たない）。
//
// このクラスは scene.ts の描画ループから毎フレーム update() され、注視デバウンス中/演出中は busy=true を
// 返してループの idle 停止（rAF 省電力）を抑止する（E3・E6: 注視は dt 駆動なのでタブ非表示で自動凍結）。
// 発火は cinematic（タイトルデモ）では常に抑止する（シネマカメラと干渉しない・要求5）。
import * as THREE from 'three';
import type { ParticleSystem } from './particles';

// ---- 検知パラメータ（要求1: 数値は報告に記載）------------------------------------
const GAZE_COS = Math.cos((10 * Math.PI) / 180); // 視線と頭部方向の角度差 ≤ 10°（頭部が視界中心付近）
const ZOOM_FOV_MAX = 40; // ズームイン判定: fov ≤ 40（既定 46/縦62 より十分小さい＝寄っている）
const GAZE_HOLD = 0.45; // 注視デバウンス 0.45s（チラ見では発火しない）
const COOLDOWN = 24; // 1体あたりのクールダウン 24s（契約 20〜30s の範囲）

interface Reaction {
  t: number;
  dur: number;
  faceYaw: number; // カメラの方へ向き直る目標ヨー
  reduced: boolean;
  heartsFired: boolean;
}

interface Doll {
  kind: 'dalmatian' | 'panda';
  obj: THREE.Object3D; // 静的モデル（この transform を直接アニメする）
  homePos: THREE.Vector3;
  homeYaw: number;
  homeRotZ: number;
  homeScale: THREE.Vector3;
  head: THREE.Vector3; // 注視判定に使う頭部ワールド座標
  gazeT: number;
  armed: boolean; // 一度発火したら視線を外す（注視解除）まで再発火しない
  cooldownUntil: number;
  reaction: Reaction | null;
}

export class PlushReactions {
  /** 効果音トリガ（app.ts で AudioKit へ接続・src/ui 側の最小 SFX 呼び出し）。 */
  onSfx: ((kind: 'wave' | 'bounce') => void) | null = null;

  private dolls: Doll[] = [];
  private fwd = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private tmpBox = new THREE.Box3();
  private tmpSize = new THREE.Vector3();

  constructor(private particles: ParticleSystem) {}

  /** 配置済みの静的モデルを個体登録する（scene.loadPlushGlbs から成功個体ごとに呼ぶ）。 */
  register(kind: 'dalmatian' | 'panda', obj: THREE.Object3D): void {
    this.dolls.push({
      kind,
      obj,
      homePos: obj.position.clone(),
      homeYaw: obj.rotation.y,
      homeRotZ: obj.rotation.z,
      homeScale: obj.scale.clone(),
      head: this.headOf(obj),
      gazeT: 0,
      armed: true,
      cooldownUntil: 0,
      reaction: null,
    });
  }

  /** モデルのバウンディングボックスから頭部（上部 78%）のワールド座標を得る。 */
  private headOf(obj: THREE.Object3D): THREE.Vector3 {
    this.tmpBox.setFromObject(obj);
    this.tmpBox.getSize(this.tmpSize);
    return new THREE.Vector3(
      (this.tmpBox.min.x + this.tmpBox.max.x) / 2,
      this.tmpBox.min.y + this.tmpSize.y * 0.78,
      (this.tmpBox.min.z + this.tmpBox.max.z) / 2,
    );
  }

  /**
   * 毎フレーム更新。注視+ズーム検知→発火、進行中リアクションの駆動を行う。
   * @returns 演出継続中/注視デバウンス中なら true（ループの idle 停止を抑止）。
   */
  update(dt: number, camera: THREE.PerspectiveCamera, camTarget: THREE.Vector3, cinematic: boolean, reduced: boolean): boolean {
    let busy = false;
    const now = performance.now() / 1000;
    const camPos = camera.position;
    const fov: number = camera.fov;
    this.fwd.subVectors(camTarget, camPos).normalize();
    const zoomOK = fov <= ZOOM_FOV_MAX;

    for (const d of this.dolls) {
      // 進行中リアクションが最優先（クールダウンが切れても完了まで再発火しない・E8）。
      if (d.reaction) {
        if (this.driveReaction(d, dt)) busy = true;
        continue;
      }

      // 注視ジオメトリ: 頭部方向が視線の GAZE_COS 円錐内か（タイトルデモでは常に非注視・要求5）。
      this.dir.subVectors(d.head, camPos).normalize();
      const inGaze = !cinematic && zoomOK && this.dir.dot(this.fwd) >= GAZE_COS;

      if (inGaze && d.armed && now >= d.cooldownUntil) {
        d.gazeT += dt;
        busy = true; // デバウンス完了まではカメラが止まってもループを回し続ける
        if (d.gazeT >= GAZE_HOLD) {
          this.fire(d, camPos, reduced);
          d.gazeT = 0;
          d.armed = false; // 視線を外すまで再発火しない
          d.cooldownUntil = now + COOLDOWN;
          busy = true;
        }
      } else {
        d.gazeT = 0;
        if (!inGaze) d.armed = true; // 視線を外したら再武装
      }
    }
    return busy;
  }

  private fire(d: Doll, camPos: THREE.Vector3, reduced: boolean): void {
    const faceYaw = Math.atan2(camPos.x - d.homePos.x, camPos.z - d.homePos.z);
    d.reaction = {
      t: 0,
      dur: d.kind === 'panda' ? (reduced ? 1.1 : 1.6) : (reduced ? 1.3 : 1.7),
      faceYaw,
      reduced,
      heartsFired: false,
    };
    // パンダ=弾む音、ダルメシアン=挨拶音（app.ts で AudioKit へ）。
    this.onSfx?.(d.kind === 'panda' ? 'bounce' : 'wave');
  }

  /** 進行中リアクションを1フレーム駆動。完了で復帰し false を返す（＝以後 busy を落とす）。 */
  private driveReaction(d: Doll, dt: number): boolean {
    const r = d.reaction!;
    r.t += dt;
    const u = Math.min(1, r.t / r.dur);
    if (d.kind === 'panda') this.animatePanda(d, r, u);
    else this.animateDalmatian(d, r, u);
    if (r.t >= r.dur) {
      this.endReaction(d); // u=1 でホームへ収束済み＝ここは厳密な確定（ポップしない）
      return false;
    }
    return true;
  }

  /** パンダ: ぷるぷる（squash&stretch）→ ぴょんと2回。カメラへ軽く向き直り、終わりに元へ戻る。 */
  private animatePanda(d: Doll, r: Reaction, u: number): void {
    const t = r.t;
    const quiverEnd = 0.24;
    let f = 1; // scale.y の倍率（体積保存で x,z を逆補正）
    let lift = 0;
    if (u < quiverEnd) {
      f = 1 + (r.reduced ? 0.02 : 0.06) * Math.sin(t * 38);
    } else {
      const hu = (u - quiverEnd) / (1 - quiverEnd); // 0..1
      const hop = (hu * 2) % 1; // 2ホップ分の各 0..1
      const H = r.reduced ? 0.1 : 0.34;
      lift = H * Math.sin(Math.PI * hop);
      f = 1 + (r.reduced ? 0.04 : 0.1) * Math.sin(Math.PI * hop);
    }
    this.applyTransform(d, f, lift, this.turnYaw(d, r, u), d.homeRotZ);
    this.maybeHearts(d, r, u, quiverEnd, 14);
  }

  /** ダルメシアン: カメラへ小さく向き直り＋左右に嬉しそうに揺れて（ロール）＋1回大きくはねる。 */
  private animateDalmatian(d: Doll, r: Reaction, u: number): void {
    const t = r.t;
    const arch = Math.sin(Math.PI * u); // 端で0・中央で最大（1回のはね/揺れ包絡）
    const H = r.reduced ? 0.08 : 0.26;
    const lift = H * arch;
    const f = 1 + (r.reduced ? 0.03 : 0.08) * arch;
    // 左右の揺れ = ロール（rotation.z）。包絡で始端/終端は 0 に収束＝スムーズ復帰。
    const swayAmp = r.reduced ? 0.05 : 0.14;
    const rotZ = d.homeRotZ + swayAmp * arch * Math.sin(t * 9);
    this.applyTransform(d, f, lift, this.turnYaw(d, r, u), rotZ);
    this.maybeHearts(d, r, u, 0.2, 16);
  }

  /** カメラの方へ向き直り、終わりに元のヨーへ戻す（up[0,0.28]→hold→down[0.72,1]・u=1でホーム）。 */
  private turnYaw(d: Doll, r: Reaction, u: number): number {
    let p: number;
    if (u < 0.28) p = u / 0.28;
    else if (u > 0.72) p = (1 - u) / 0.28;
    else p = 1;
    return this.lerpAngle(d.homeYaw, r.faceYaw, this.smooth(p));
  }

  private applyTransform(d: Doll, f: number, lift: number, yaw: number, rotZ: number): void {
    const base = d.homeScale;
    const inv = 1 / Math.sqrt(f);
    d.obj.scale.set(base.x * inv, base.y * f, base.z * inv);
    d.obj.position.set(d.homePos.x, d.homePos.y + lift, d.homePos.z);
    d.obj.rotation.y = yaw;
    d.obj.rotation.z = rotZ;
  }

  private maybeHearts(d: Doll, r: Reaction, u: number, after: number, count: number): void {
    if (!r.heartsFired && u >= after) {
      r.heartsFired = true;
      if (!r.reduced) this.particles.hearts(d.head, count); // reduced-motion では抑制（E4）
    }
  }

  /** リアクション終了: 静的モデルの姿勢（位置・向き・ロール・スケール）を厳密に元へ戻す。 */
  private endReaction(d: Doll): void {
    d.obj.position.copy(d.homePos);
    d.obj.rotation.y = d.homeYaw;
    d.obj.rotation.z = d.homeRotZ;
    d.obj.scale.copy(d.homeScale);
    d.reaction = null;
  }

  // ---- 小物 ----------------------------------------------------------------------
  private smooth(u: number): number {
    const t = u < 0 ? 0 : u > 1 ? 1 : u;
    return t * t * (3 - 2 * t);
  }

  private lerpAngle(a: number, b: number, t: number): number {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // ---- 検証用アクセサ（scene の __plushProbe から参照・描画層内で完結）------------
  debugHead(kind: 'dalmatian' | 'panda'): THREE.Vector3 | null {
    return this.dolls.find((d) => d.kind === kind)?.head ?? null;
  }

  debugState(): unknown {
    const now = performance.now() / 1000;
    const r = (n: number): number => +n.toFixed(3);
    return {
      ready: true,
      params: { gazeCos: r(GAZE_COS), zoomFovMax: ZOOM_FOV_MAX, gazeHold: GAZE_HOLD, cooldown: COOLDOWN },
      dolls: this.dolls.map((d) => ({
        kind: d.kind,
        head: (d.head.toArray() as number[]).map((n) => +n.toFixed(2)),
        gazeT: r(d.gazeT),
        armed: d.armed,
        cooldownIn: r(Math.max(0, d.cooldownUntil - now)),
        reaction: d.reaction ? d.kind : null,
        reactionT: r(d.reaction?.t ?? 0),
        staticVisible: d.obj.visible,
        // live transform（検証: パンダははね=posY、ダルメシアンは揺れ=rotZ／終了で home へ収束）
        posY: r(d.obj.position.y), rotZ: r(d.obj.rotation.z), scaleY: r(d.obj.scale.y),
        home: { posY: r(d.homePos.y), rotZ: r(d.homeRotZ), scaleY: r(d.homeScale.y) },
      })),
    };
  }

  dispose(): void {
    for (const d of this.dolls) {
      // 演出中に破棄された場合は姿勢を確定させておく（E3・進行に影響なし）。
      if (d.reaction) this.endReaction(d);
    }
    this.dolls = [];
  }
}
