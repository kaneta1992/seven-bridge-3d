// Three.js 3D 卓シーン。すべてプロシージャル（外部アセットなし・要件 D7 / §3.2）。
// アニメーションは「各カードを目標トランスフォームへ毎フレーム補間」する統一モデル。
// これにより 配札/ツモ/捨て札/メルド公開/付け札/ポン・チー が同一機構で滑らかに表現され、
// 即時テレポートを避ける（要件§3.2）。ジオメトリ/マテリアルは共有し draw call を抑制（E5）。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Card, Meld, PlayerView } from '../core';
import { cardId } from '../core';
import { backTexture, disposeCardTextures, faceTexture, setMaxAnisotropy } from './cardTexture';
import { disposeFelt, feltTexture } from './felt';
import { ParticleSystem } from './particles';
import { createPostFX, type PostFX } from './postfx';
import { detectQuality, type QualityTier } from './quality';

const CARD_W = 0.72;
const CARD_H = 1.0;
const CARD_D = 0.02;
const TABLE_TOP_Y = 0;
const SEAT_R = 2.55; // 席の半径
const HAND_SPACING = 0.52;
const EASE_SPEED = 7.5; // 補間の速さ（大きいほど機敏）
const DEAL_STEP_MS = 42; // 配札スタッガ（1枚ごとの遅延）
const MAX_RINGS = 5; // 光輪（ショックウェーブ）の同時上限

interface CardObj {
  id: string;
  group: THREE.Group;
  born: number;
  delay: number;
  targetPos: THREE.Vector3;
  targetQuat: THREE.Quaternion;
  removing: boolean;
  removeAt: number;
  spawned: boolean;
  meldId?: number; // 面カードが 3D メルドに属する場合の所属メルドID（レイキャスト付け札用・R4項目5）
}

export class TableScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  // 共有リソース
  private bodyGeo: RoundedBoxGeometry;
  private planeGeo: THREE.PlaneGeometry;
  private bodyMat: THREE.MeshStandardMaterial;
  private backMat: THREE.MeshStandardMaterial;
  private frontMatCache = new Map<string, THREE.MeshStandardMaterial>();
  private raycaster = new THREE.Raycaster(); // 3D メルドの当たり判定（付け札D&D・R4項目5）

  // 既知カード（面が判明: 自手札/捨て札/メルド）を cardId で管理
  private known = new Map<string, CardObj>();
  // 匿名の裏カード（他家手札・山札）のプール
  private backPool: CardObj[] = [];

  // カメラ演出
  private camPos = new THREE.Vector3(0, 4, 6);
  private camTarget = new THREE.Vector3(0, 0, 0);
  private camPosGoal = new THREE.Vector3(0, 4, 6);
  private camTargetGoal = new THREE.Vector3(0, 0, 0);

  private seatCount = 4;
  private raf = 0;
  private running = false;
  private idle = 0;
  private container: HTMLElement;

  // 演出まわり（ジューシー化ラウンド）
  private quality: QualityTier = detectQuality();
  private particles: ParticleSystem;
  private postfx: PostFX | null = null;
  private envMap: THREE.Texture | null = null;
  private spot!: THREE.SpotLight;
  private spotPos = new THREE.Vector3(0, 9, 0.5);
  private spotTarget = new THREE.Vector3(0, 0, 0);
  private spotPosGoal = new THREE.Vector3(0, 9, 0.5);
  private spotTargetGoal = new THREE.Vector3(0, 0, 0);
  private camKick = 0; // カメラパンチの残量（減衰）
  private freshDeal = false; // clearCards 直後の一括配札（スタッガ演出）
  private ringGeo!: THREE.RingGeometry;
  private rings: { mesh: THREE.Mesh; t: number; dur: number; r0: number; r1: number }[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.quality.maxDpr));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a1018');
    this.scene.fog = new THREE.Fog('#080d14', 9, 22);
    if (this.quality.envMap) {
      this.envMap = this.buildEnvMap();
      this.scene.environment = this.envMap;
    }

    this.camera = new THREE.PerspectiveCamera(45, this.aspect(), 0.1, 100);
    this.camera.position.copy(this.camPos);

    this.bodyGeo = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, 4, 0.06);
    this.planeGeo = new THREE.PlaneGeometry(CARD_W * 0.98, CARD_H * 0.98);
    // カード本体は MeshPhysicalMaterial の clearcoat でラミネート加工の艶を出す（3D品質）。
    this.bodyMat = new THREE.MeshPhysicalMaterial({
      color: '#f4f1e8',
      roughness: 0.5,
      metalness: 0.0,
      clearcoat: 0.6,
      clearcoatRoughness: 0.28,
      envMapIntensity: 0.35,
      // 本体を深度方向へ僅かに後退させ、面テクスチャ平面が常に手前で描画される（Z-fighting 対策）
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.backMat = new THREE.MeshPhysicalMaterial({
      map: backTexture(),
      roughness: 0.42,
      metalness: 0.05,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.4,
    });

    this.ringGeo = new THREE.RingGeometry(0.86, 1.0, 48);
    this.particles = new ParticleSystem(this.quality.sparkCap, this.quality.confettiCap, this.particleScale());
    this.particles.addTo(this.scene);

    this.buildEnvironment();

    if (this.quality.bloom) {
      this.postfx = createPostFX(
        this.renderer,
        this.scene,
        this.camera,
        Math.max(1, container.clientWidth),
        Math.max(1, container.clientHeight),
      );
      if (this.postfx) this.postfx.setSize(container.clientWidth, container.clientHeight, this.renderer.getPixelRatio());
    }

    this.wake();
  }

  /** パーティクルの gl_PointSize スケール（描画高さ×DPR に比例させ、縦横で見た目を一定に保つ）。 */
  private particleScale(): number {
    const h = Math.max(1, this.container.clientHeight) * this.renderer.getPixelRatio();
    return h * 0.9;
  }

  /** 反射用の簡易な等角環境マップ（プロシージャル・外部アセットなし）。clearcoat に映り込みを与える。 */
  private buildEnvMap(): THREE.Texture {
    const w = 256;
    const h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#39506e'); // 上: 冷たい天井光
    g.addColorStop(0.42, '#243244');
    g.addColorStop(0.5, '#7d8ea6'); // 水平帯: ソフトなスタジオ光
    g.addColorStop(0.58, '#1a2430');
    g.addColorStop(1, '#0a0f16'); // 下: 暗い床
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // 天頂付近に淡い光源を1つ置き、艶に映り込むハイライトを作る
    const spot = ctx.createRadialGradient(w * 0.5, h * 0.22, 2, w * 0.5, h * 0.22, 46);
    spot.addColorStop(0, 'rgba(255,244,220,0.9)');
    spot.addColorStop(1, 'rgba(255,244,220,0)');
    ctx.fillStyle = spot;
    ctx.fillRect(0, 0, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** 補間ループを起動（settle 後は自動停止するため、状態変化のたびに呼ぶ）。 */
  private wake(): void {
    this.idle = 0;
    if (!this.running) {
      this.running = true;
      this.clock.getDelta(); // 蓄積した dt を捨てる
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  private aspect(): number {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    return w / h;
  }

  private buildEnvironment(): void {
    // 3灯構成（キー+リム+フィル）+ 半球/環境光 + 手番スポット。豪華なスタジオライティング。
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x24301f, 0.55));

    const key = new THREE.DirectionalLight(0xfff4e0, 1.35);
    key.position.set(3.5, 8, 4);
    key.castShadow = true;
    const sm = this.quality.shadowMap;
    key.shadow.mapSize.set(sm, sm);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 25;
    const d = 7;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 3;
    this.scene.add(key);

    // リムライト（冷色・背後から）: カード/縁の輪郭を際立たせ立体感を出す
    const rimLight = new THREE.DirectionalLight(0x88b4ff, 0.7);
    rimLight.position.set(-4, 5.5, -5);
    this.scene.add(rimLight);

    // フィルライト（弱・正面下から影を柔らかく）
    const fill = new THREE.DirectionalLight(0xffe9cf, 0.3);
    fill.position.set(-2, 3, 6);
    this.scene.add(fill);

    // 手番スポット: 現手番席の上へ移動して照らす（誰の番かを光で示す）
    this.spot = new THREE.SpotLight(0xfff6e8, 46, 22, Math.PI / 6, 0.55, 1.3);
    this.spot.position.copy(this.spotPos);
    this.spot.target.position.copy(this.spotTarget);
    this.spot.castShadow = false;
    this.scene.add(this.spot);
    this.scene.add(this.spot.target);

    // 卓（フェルト天板 + 木縁）。フェルトは sheen で布の質感、木縁は clearcoat で艶。
    const feltMat = new THREE.MeshPhysicalMaterial({
      map: feltTexture(),
      roughness: 0.92,
      metalness: 0.0,
      sheen: 0.7,
      sheenRoughness: 0.85,
      sheenColor: new THREE.Color('#2f8f5a'),
      envMapIntensity: 0.25,
    });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 0.3, 72), feltMat);
    top.position.y = TABLE_TOP_Y - 0.15;
    top.receiveShadow = true;
    this.scene.add(top);

    const rimMat = new THREE.MeshPhysicalMaterial({
      color: '#5a3a21',
      roughness: 0.45,
      metalness: 0.2,
      clearcoat: 0.7,
      clearcoatRoughness: 0.35,
      envMapIntensity: 0.6,
    });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.16, 24, 80), rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = TABLE_TOP_Y;
    rim.castShadow = true;
    rim.receiveShadow = true;
    this.scene.add(rim);

    // 床（影の受け皿）
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 48),
      new THREE.MeshStandardMaterial({ color: '#0c141d', roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.45;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  // ---- カードメッシュ生成（共有ジオメトリ/マテリアル） --------------------

  private frontMat(card: Card): THREE.MeshStandardMaterial {
    const key = cardId(card);
    let m = this.frontMatCache.get(key);
    if (!m) {
      m = new THREE.MeshPhysicalMaterial({
        map: faceTexture(card),
        roughness: 0.42,
        metalness: 0.02,
        clearcoat: 0.55,
        clearcoatRoughness: 0.25,
        envMapIntensity: 0.4,
      });
      this.frontMatCache.set(key, m);
    }
    return m;
  }

  private buildCard(card: Card | null): THREE.Group {
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.bodyMat);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const back = new THREE.Mesh(this.planeGeo, this.backMat);
    back.rotation.y = Math.PI;
    back.position.z = -(CARD_D / 2 + 0.006); // 本体面から十分に離し共面を避ける
    g.add(back);

    if (card) {
      const front = new THREE.Mesh(this.planeGeo, this.frontMat(card));
      front.position.z = CARD_D / 2 + 0.006;
      g.add(front);
    }
    return g;
  }

  // ---- レイアウト計算 -----------------------------------------------------

  private seatAngle(i: number): number {
    return Math.PI / 2 + (i * 2 * Math.PI) / this.seatCount;
  }

  private seatDir(i: number): THREE.Vector3 {
    const a = this.seatAngle(i);
    return new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  }

  /** 卓に平置きし、top 辺を center 方向（=そのカメラから見て上）へ向けるクォータニオン。 */
  private flatQuat(seatIndex: number, extraYaw = 0, faceUp = true): THREE.Quaternion {
    const a = this.seatAngle(seatIndex);
    const e = new THREE.Euler(faceUp ? -Math.PI / 2 : Math.PI / 2, -a + Math.PI / 2 + extraYaw, 0, 'YXZ');
    return new THREE.Quaternion().setFromEuler(e);
  }

  private handPositions(seatIndex: number, count: number): THREE.Vector3[] {
    const dir = this.seatDir(seatIndex);
    const tangent = new THREE.Vector3(-dir.z, 0, dir.x);
    const anchor = dir.clone().multiplyScalar(SEAT_R - 0.15);
    const out: THREE.Vector3[] = [];
    for (let k = 0; k < count; k++) {
      const t = k - (count - 1) / 2;
      const p = anchor
        .clone()
        .addScaledVector(tangent, t * HAND_SPACING)
        .add(new THREE.Vector3(0, TABLE_TOP_Y + 0.04 + k * 0.004, 0))
        // 手前ほど中心から少し離す（扇の膨らみ）
        .addScaledVector(dir, -Math.abs(t) * 0.03);
      out.push(p);
    }
    return out;
  }

  // ---- 状態反映 -----------------------------------------------------------

  update(view: PlayerView): void {
    this.seatCount = view.seats.length;
    const now = performance.now();
    const seatIndexById = new Map<string, number>();
    view.seats.forEach((s) => seatIndexById.set(s.id, s.index));

    const desired = new Set<string>();
    // 卓上の中央ゾーン再設計（改善R3 項目1・2）: 山札と捨て札を中央付近へコンパクトに寄せ、
    // 各席のメルドゾーン（radial 方向・外周寄り）と侵食しないよう左右に小さく分ける。
    // 山札＝中央やや右、捨て札＝中央やや左。両者の間隔を狭め視認性を上げる。
    const deckPos = new THREE.Vector3(0.5, TABLE_TOP_Y + 0.05, 0);

    // 1) 自手札は 3D に描画しない（改善R3 項目3）。画面下部の 2D DOM（扇形手札）のみが担当する。
    //    他家の裏向き手札（section 4）と山札（section 5）は 3D 継続。
    //    place() の spawn 元として deckPos を使うため、捨て札/メルドの初出カードは山札から出る演出になる。

    // 2) メルド（面表示）: 所有者席前に整列。メルドが増えても重ならないよう
    //    「1行の幅を超えたら中心側の段へ折り返す」パッキングで配置し、
    //    全メルドカードへ単調増加の微小 y を与えて共面（Z-fighting）を防ぐ。
    const meldsBySeat = new Map<number, Meld[]>();
    for (const meld of view.melds) {
      const seat = seatIndexById.get(meld.owner) ?? view.youIndex;
      const arr = meldsBySeat.get(seat) ?? [];
      arr.push(meld);
      meldsBySeat.set(seat, arr);
    }
    const CARD_STEP = 0.34; // メルド内カード間隔（適度な重なり）
    const MELD_GAP = 0.42; // メルド間の余白
    const ROW_PITCH = 0.64; // 折り返し段の半径方向ピッチ
    // 席数が多いほど隣席と干渉しないよう1行の幅を狭める
    const rowBudget = this.seatCount >= 5 ? 1.9 : this.seatCount === 4 ? 2.5 : 3.1;
    const widthOf = (m: Meld): number => Math.max(1, m.cards.length) * CARD_STEP;
    let ySeq = 0; // 全メルドカード通し番号（y 段差用）
    for (const [seat, melds] of meldsBySeat) {
      const dir = this.seatDir(seat);
      const tangent = new THREE.Vector3(-dir.z, 0, dir.x);
      // メルドを行に貪欲パッキング
      const rows: Meld[][] = [];
      let row: Meld[] = [];
      let rowW = 0;
      for (const m of melds) {
        const w = widthOf(m);
        if (row.length && rowW + MELD_GAP + w > rowBudget) {
          rows.push(row);
          row = [];
          rowW = 0;
        }
        rowW += (row.length ? MELD_GAP : 0) + w;
        row.push(m);
      }
      if (row.length) rows.push(row);

      rows.forEach((rowMelds, r) => {
        const total =
          rowMelds.reduce((s, m) => s + widthOf(m), 0) + MELD_GAP * (rowMelds.length - 1);
        const radial = SEAT_R * 0.62 - r * ROW_PITCH;
        let cursor = -total / 2; // 行左端の接線座標
        for (const meld of rowMelds) {
          const w = widthOf(meld);
          meld.cards.forEach((card, k) => {
            const id = cardId(card);
            desired.add(id);
            const tan = cursor + (k + 0.5) * CARD_STEP;
            const p = dir
              .clone()
              .multiplyScalar(radial)
              .addScaledVector(tangent, tan)
              .add(new THREE.Vector3(0, TABLE_TOP_Y + 0.05 + ySeq * 0.006, 0));
            ySeq++;
            this.place(id, card, p, this.flatQuat(seat, 0, true), now, 0, deckPos, meld.id);
          });
          cursor += w + MELD_GAP;
        }
      });
    }

    // 3) 捨て札（面表示・中央やや左に散らし、決定的ジッタ）。山札(+x)と近接しつつ重ならないよう
    //    ジッタ幅を控えめにする（改善R3 項目1・2）。
    const discardStart = new THREE.Vector3(-0.5, TABLE_TOP_Y, 0);
    view.discardPile.forEach((card, k) => {
      const id = cardId(card);
      desired.add(id);
      const jx = (hashId(id) % 100) / 100 - 0.5;
      const jz = (((hashId(id) / 7) | 0) % 100) / 100 - 0.5;
      const p = discardStart
        .clone()
        .add(new THREE.Vector3(jx * 0.28, TABLE_TOP_Y + 0.03 + k * 0.008, jz * 0.28));
      const q = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-Math.PI / 2, jx * 0.6, 0, 'YXZ'),
      );
      this.place(id, card, p, q, now, 0, deckPos);
    });

    // 既知カードのうち今回不要になったものを退場アニメ
    for (const [id, obj] of this.known) {
      if (!desired.has(id) && !obj.removing) {
        obj.removing = true;
        obj.removeAt = now;
      }
    }

    // 4) 他家手札（匿名裏カード）+ 5) 山札（裏カードのスタック）
    const backTargets: { pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];
    view.seats.forEach((seat) => {
      if (seat.index === view.youIndex) return;
      const pos = this.handPositions(seat.index, seat.handCount);
      pos.forEach((p, k) => {
        const fan = (k - (seat.handCount - 1) / 2) * 0.05;
        backTargets.push({ pos: p, quat: this.flatQuat(seat.index, fan, false) });
      });
    });
    const deckShown = Math.min(view.deckCount, 14);
    for (let i = 0; i < deckShown; i++) {
      backTargets.push({
        pos: new THREE.Vector3(0.5, TABLE_TOP_Y + 0.03 + i * 0.02, 0),
        quat: new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)),
      });
    }
    const dealing = this.freshDeal;
    this.freshDeal = false;
    this.syncBackPool(backTargets, now, dealing, deckPos);

    // カメラを現手番（=youIndex）席の背後へ演出移動
    this.aimCameraAt(view.youIndex);
    // 手番スポットは「現手番の席」を照らす（通信対戦では youIndex と別席になり得る）
    const curSeat = view.seats.find((s) => s.isCurrent)?.index ?? view.youIndex;
    this.setActiveSeat(curSeat);
    this.wake();
  }

  /** 手番スポットの照射先を指定席へ移す（誰の番かを光で示す・E3 では縦画面でも卓中央寄りに収まる）。 */
  private setActiveSeat(seatIndex: number): void {
    const dir = this.seatDir(seatIndex);
    this.spotTargetGoal.copy(dir).multiplyScalar(SEAT_R * 0.7);
    this.spotTargetGoal.y = 0;
    this.spotPosGoal.copy(dir).multiplyScalar(SEAT_R * 0.5);
    this.spotPosGoal.y = 8.5;
    this.wake();
  }

  private place(
    id: string,
    card: Card,
    pos: THREE.Vector3,
    quat: THREE.Quaternion,
    now: number,
    delay: number,
    spawnPos: THREE.Vector3,
    meldId?: number,
  ): void {
    let obj = this.known.get(id);
    if (!obj) {
      const group = this.buildCard(card);
      group.position.copy(spawnPos);
      group.quaternion.copy(quat);
      group.scale.setScalar(0.55); // 出現ポップ（loop で 1 へイージング）
      this.scene.add(group);
      obj = {
        id,
        group,
        born: now,
        delay,
        targetPos: pos.clone(),
        targetQuat: quat.clone(),
        removing: false,
        removeAt: 0,
        spawned: false,
        meldId,
      };
      this.known.set(id, obj);
    } else {
      obj.targetPos.copy(pos);
      obj.targetQuat.copy(quat);
      obj.removing = false;
      obj.group.scale.setScalar(1);
      obj.meldId = meldId;
    }
    // 付け札レイキャスト用にメルド所属をグループへ刻む（非メルドは null）
    obj.group.userData.meldId = meldId ?? null;
  }

  /** クライアント座標にある 3D メルドの meldId を返す（無ければ null）。付け札D&D用（R4項目5）。 */
  meldIdAt(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const groups: THREE.Object3D[] = [];
    for (const obj of this.known.values()) {
      if (obj.meldId != null && !obj.removing) groups.push(obj.group);
    }
    if (groups.length === 0) return null;
    const hits = this.raycaster.intersectObjects(groups, true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      while (o && o.userData?.meldId == null) o = o.parent;
      const mid = o?.userData?.meldId;
      if (typeof mid === 'number') return mid;
    }
    return null;
  }

  private syncBackPool(
    targets: { pos: THREE.Vector3; quat: THREE.Quaternion }[],
    now: number,
    dealing: boolean,
    deckPos: THREE.Vector3,
  ): void {
    // 必要数までプール拡張
    while (this.backPool.length < targets.length) {
      const group = this.buildCard(null);
      group.visible = false;
      this.scene.add(group);
      this.backPool.push({
        id: `back${this.backPool.length}`,
        group,
        born: now,
        delay: 0,
        targetPos: new THREE.Vector3(),
        targetQuat: new THREE.Quaternion(),
        removing: false,
        removeAt: 0,
        spawned: true,
      });
    }
    this.backPool.forEach((obj, i) => {
      if (i < targets.length) {
        if (!obj.group.visible) {
          obj.group.visible = true;
          if (dealing) {
            // 配札演出: 山札からリズミカルに1枚ずつ飛び出す（loop が delay 経過後に補間開始）
            obj.group.position.copy(deckPos);
            obj.group.quaternion.copy(targets[i]!.quat);
            obj.born = now;
            obj.delay = i * DEAL_STEP_MS;
          } else {
            obj.group.position.copy(targets[i]!.pos);
            obj.group.quaternion.copy(targets[i]!.quat);
            obj.born = now;
            obj.delay = 0;
          }
        }
        obj.targetPos.copy(targets[i]!.pos);
        obj.targetQuat.copy(targets[i]!.quat);
      } else {
        obj.group.visible = false;
      }
    });
  }

  // ---- 演出 API（app.ts のイベント検出から呼ばれる） -----------------------

  /** 席前の卓上ワールド座標（メルド/鳴きの発火点）。 */
  private seatSpot(seatIndex: number, radialK = 0.55): THREE.Vector3 {
    const dir = this.seatDir(seatIndex);
    return dir.clone().multiplyScalar(SEAT_R * radialK).setY(TABLE_TOP_Y + 0.12);
  }

  /** メルド公開の決め演出: 金色スパーク + 光輪 + 軽いカメラパンチ。 */
  publishEffect(seatIndex: number): void {
    const p = this.seatSpot(seatIndex);
    this.particles.burst(p, { count: 30, color: [1, 0.82, 0.36], speed: 2.4, size: 0.1, life: 0.75 });
    this.spawnRing(p, '#ffd873');
    this.cameraPunch(0.5);
    this.wake();
  }

  /** ポン/チーの鳴き演出: 種別で色分けしたスパーク + 光輪 + 強めのカメラパンチ。 */
  claimEffect(seatIndex: number, kind: 'pon' | 'chi'): void {
    const p = this.seatSpot(seatIndex);
    const color: [number, number, number] = kind === 'pon' ? [1, 0.45, 0.3] : [0.4, 0.72, 1];
    this.particles.burst(p, { count: 40, color, speed: 3.0, size: 0.12, life: 0.8, spread: 1 });
    this.spawnRing(p, kind === 'pon' ? '#ff7a4d' : '#66b6ff');
    this.cameraPunch(0.85);
    this.wake();
  }

  /** 上がり/ラウンド終了のセレブレーション: 卓上に紙吹雪噴水 + 金スパーク + カメラパンチ。 */
  celebrate(seatIndex: number): void {
    const p = this.seatSpot(seatIndex, 0.4);
    const fountain = new THREE.Vector3(0, TABLE_TOP_Y + 0.2, 0);
    this.particles.confettiFountain(fountain, Math.min(this.quality.confettiCap, 240));
    this.particles.burst(p, { count: 44, color: [1, 0.9, 0.5], speed: 3.2, size: 0.13, life: 1.1 });
    this.spawnRing(p, '#ffe08a');
    this.cameraPunch(1.0);
    this.wake();
  }

  /** カメラのドリーパンチ（減衰）。reduced-motion 時はシェイクを伴わない（quality.cameraShake）。 */
  cameraPunch(intensity: number): void {
    this.camKick = Math.max(this.camKick, intensity);
    this.wake();
  }

  private spawnRing(pos: THREE.Vector3, color: string): void {
    if (this.rings.length >= MAX_RINGS) {
      const old = this.rings.shift();
      if (old) this.scene.remove(old.mesh);
    }
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(pos);
    mesh.renderOrder = 9;
    this.scene.add(mesh);
    this.rings.push({ mesh, t: 0, dur: 0.55, r0: 0.2, r1: 2.6 });
  }

  private aimCameraAt(seatIndex: number): void {
    const dir = this.seatDir(seatIndex);
    const portrait = this.aspect() < 1;
    const back = portrait ? 3.4 : 2.7;
    const height = portrait ? 4.6 : 3.6;
    const fwd = portrait ? 0.1 : 0.35;
    this.camPosGoal.copy(dir).multiplyScalar(SEAT_R + back);
    this.camPosGoal.y = height;
    this.camTargetGoal.copy(dir).multiplyScalar(fwd);
    this.camTargetGoal.y = 0;
    this.camera.fov = portrait ? 58 : 46;
    this.camera.updateProjectionMatrix();
  }

  // ---- 描画ループ ---------------------------------------------------------

  private loop = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const k = 1 - Math.exp(-EASE_SPEED * dt);
    const now = performance.now();
    let motion = 0; // 残り移動量の指標（settle 判定用）
    let busy = false; // 退場アニメ等で継続が必要か
    let fxBusy = false; // 粒子/光輪/カメラパンチ等の演出が継続中か

    // カメラ補間
    motion += this.camPos.distanceTo(this.camPosGoal) + this.camTarget.distanceTo(this.camTargetGoal);
    this.camPos.lerp(this.camPosGoal, k * 0.6);
    this.camTarget.lerp(this.camTargetGoal, k * 0.6);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    // カメラパンチ（ドリーイン + 任意シェイク）。減衰して settle へ戻る。
    if (this.camKick > 0.001) {
      const toTarget = TMP_A.subVectors(this.camTarget, this.camPos).normalize();
      this.camera.position.addScaledVector(toTarget, this.camKick * 0.32);
      if (this.quality.cameraShake) {
        this.camera.position.x += (Math.random() - 0.5) * this.camKick * 0.14;
        this.camera.position.y += (Math.random() - 0.5) * this.camKick * 0.14;
      }
      this.camera.lookAt(this.camTarget);
      this.camKick *= Math.exp(-9 * dt);
      if (this.camKick < 0.02) this.camKick = 0;
      fxBusy = true;
    }

    // 手番スポットの追従
    motion += this.spotPos.distanceTo(this.spotPosGoal) + this.spotTarget.distanceTo(this.spotTargetGoal);
    this.spotPos.lerp(this.spotPosGoal, k * 0.5);
    this.spotTarget.lerp(this.spotTargetGoal, k * 0.5);
    this.spot.position.copy(this.spotPos);
    this.spot.target.position.copy(this.spotTarget);
    this.spot.target.updateMatrixWorld?.();

    // 既知カード補間 + 出現ポップ + 退場処理
    for (const [id, obj] of this.known) {
      if (now - obj.born >= obj.delay) {
        obj.spawned = true;
        motion += obj.group.position.distanceTo(obj.targetPos);
        obj.group.position.lerp(obj.targetPos, k);
        obj.group.quaternion.slerp(obj.targetQuat, k);
        if (!obj.removing) {
          const s = obj.group.scale.x;
          if (s < 0.999) {
            const ns = s + (1 - s) * k;
            obj.group.scale.setScalar(ns);
            motion += 1 - s;
          }
        }
      } else {
        busy = true; // 配札ディレイ待ち
      }
      if (obj.removing) {
        busy = true;
        const s = Math.max(0, 1 - (now - obj.removeAt) / 260);
        obj.group.scale.setScalar(s);
        if (s <= 0.001) {
          this.scene.remove(obj.group);
          this.known.delete(id);
        }
      }
    }
    // 裏カード補間（配札スタッガの delay を尊重）
    for (const obj of this.backPool) {
      if (!obj.group.visible) continue;
      if (now - obj.born < obj.delay) {
        busy = true;
        continue;
      }
      motion += obj.group.position.distanceTo(obj.targetPos);
      obj.group.position.lerp(obj.targetPos, k);
      obj.group.quaternion.slerp(obj.targetQuat, k);
    }

    // 光輪（ショックウェーブ）: 拡大しながらフェードアウト
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      r.t += dt;
      const u = r.t / r.dur;
      if (u >= 1) {
        this.scene.remove(r.mesh);
        (r.mesh.material as { dispose?: () => void }).dispose?.();
        this.rings.splice(i, 1);
        continue;
      }
      const ease = 1 - (1 - u) * (1 - u); // easeOutQuad
      r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * ease);
      r.mesh.material.opacity = 0.85 * (1 - u);
      fxBusy = true;
    }

    // パーティクル
    if (this.particles.update(dt)) fxBusy = true;

    // 描画（Bloom があればコンポーザ経由）
    if (this.postfx) this.postfx.render();
    else this.renderer.render(this.scene, this.camera);

    // settle したら次ラウンド/操作まで RAF を停止（省電力・E5 / スクショ可能化）。
    // 演出（fxBusy）継続中は idle させない（E10: 演出終了で確実に settle する）。
    if (motion < 0.004 && !busy && !fxBusy) this.idle++;
    else this.idle = 0;
    if (this.idle > 4) {
      this.running = false;
    } else {
      this.raf = requestAnimationFrame(this.loop);
    }
  };

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    this.postfx?.setSize(w, h, this.renderer.getPixelRatio());
    this.particles.setScale(this.particleScale());
    this.wake();
  }

  /** ラウンド切り替え等でカードを全消去（次の update で再構築＝配札スタッガ演出）。 */
  clearCards(): void {
    for (const [, obj] of this.known) this.scene.remove(obj.group);
    this.known.clear();
    for (const obj of this.backPool) obj.group.visible = false;
    this.freshDeal = true;
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;

    // 演出資源（コンテキストロスト対策・E11）: 光輪 → パーティクル → コンポーザ → 環境マップ
    for (const r of this.rings) {
      this.scene.remove(r.mesh);
      (r.mesh.material as { dispose?: () => void }).dispose?.();
    }
    this.rings.length = 0;
    this.ringGeo.dispose?.();
    this.particles.dispose();
    this.postfx?.dispose();
    this.postfx = null;
    this.envMap?.dispose?.();
    this.envMap = null;
    this.scene.environment = null;

    // シーングラフ上の全ジオメトリ/マテリアルを解放（卓・縁・床・カード等）
    this.scene.traverse((obj: { geometry?: { dispose?: () => void }; material?: unknown }) => {
      obj.geometry?.dispose?.();
      const mat = obj.material;
      if (mat) {
        const mats = Array.isArray(mat) ? mat : [mat];
        for (const m of mats as { dispose?: () => void }[]) m.dispose?.();
      }
    });

    // 共有リソース（シーン未追加のプールも含めて明示的に解放）
    this.bodyGeo.dispose?.();
    this.planeGeo.dispose?.();
    this.bodyMat.dispose?.();
    this.backMat.dispose?.();
    for (const m of this.frontMatCache.values()) m.dispose?.();
    this.frontMatCache.clear();
    // モジュールキャッシュのテクスチャを破棄しクリア（次シーンで再生成される）
    disposeCardTextures();
    disposeFelt();

    this.known.clear();
    this.backPool.length = 0;

    this.renderer.dispose();
    if (this.renderer.domElement.parentElement === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}

const TMP_A = new THREE.Vector3(); // ループ内の一時ベクトル（毎フレームの new を避ける）

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return h;
}
