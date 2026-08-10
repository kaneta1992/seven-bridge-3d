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
import { orderedMeldCards } from './meldSort';
import { ParticleSystem } from './particles';
import { BLOOM_LAYER, createPostFX, type PostFX } from './postfx';
import { detectQuality, type QualityTier } from './quality';

const CARD_W = 0.72;
const CARD_H = 1.0;
const CARD_D = 0.02;
const TABLE_TOP_Y = 0;
const SEAT_R = 2.55; // 席の半径
const HAND_SPACING = 0.52;
const EASE_SPEED = 7.5; // 補間の速さ（大きいほど機敏）
const DEAL_STEP_MS = 42; // 配札スタッガ（1枚ごとの遅延）
const MAX_RINGS = 10; // 光輪（ショックウェーブ）の同時上限（派手化で二重リングを出すため増量・契約09項目2）
const DISCARD_C = new THREE.Vector3(-0.5, TABLE_TOP_Y, 0); // 捨て札の山の中心（update と一致）
const DISCARD_R = 0.62; // 捨て札ドロップ判定の半径（山札 +0.5 と干渉しない大きさ）
const TABLE_R = 3.5; // 卓天板の半径（この外へのドロップは卓外＝取り消し）

// ユーザーカメラ操作（契約07項目1）: 卓中心まわりのオービット。ズーム=半径、スワイプ=方位/仰角。
const MIN_ORBIT_R = 3.4; // ズーム最接近（卓面へ寄れる下限・クリッピング回避）
const MAX_ORBIT_R = 13.0; // ズーム最遠（全卓俯瞰の上限・fog 手前に収める）
const MIN_ORBIT_PITCH = 0.14; // 仰角下限（卓すれすれ・約8°。遠い席名を見に行ける）
const MAX_ORBIT_PITCH = 1.45; // 仰角上限（ほぼ真上・約83°。卓が裏返らない）
const ORBIT_YAW_SENS = 0.006; // 方位感度（rad/px）
const ORBIT_PITCH_SENS = 0.006; // 仰角感度（rad/px）

// 3D 卓上のドロップ標的（契約05項目1）。手札カードのドラッグ先を screen→3D で判定する。
export type DropTarget =
  | { kind: 'discard' }
  | { kind: 'field' }
  | { kind: 'meld'; meldId: number };

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

  // ユーザーカメラ操作の状態（契約07項目1）。userControlled 中は自動フレーミング（aimCameraAt）を
  // 抑止し、ユーザーが選んだ視点を保持する。リセットボタン / ラウンド切替（clearCards）で解除。
  private userControlled = false;
  private orbitYaw = 0;
  private orbitPitch = 0.6;
  private orbitRadius = 7.4;
  private orbitTarget = new THREE.Vector3();
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private onCamPointerDown!: (e: PointerEvent) => void;
  private onCamPointerMove!: (e: PointerEvent) => void;
  private onCamPointerUp!: (e: PointerEvent) => void;
  private onCamWheel!: (e: WheelEvent) => void;

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
  private rings: { mesh: THREE.Mesh; t: number; dur: number; r0: number; r1: number; op: number }[] = [];

  // 3D ドロップ標的の視覚化（契約05項目1）: 捨て札リング・場（公開）リング・付け札メルドの光枠。
  private tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(TABLE_TOP_Y + 0.04));
  private dropActive = false;
  private discardRing!: THREE.Mesh;
  private fieldRing!: THREE.Mesh;
  private meldRingGeo!: THREE.RingGeometry;
  private activeMeldRings: THREE.Mesh[] = [];
  private dropRings: {
    mesh: THREE.Mesh;
    kind: 'discard' | 'field' | 'meld';
    meldId?: number;
    hot: boolean;
  }[] = [];
  private viewYou = 0; // 現手番（=自席）インデックス。場リングの配置に使う。

  // 席名ビルボードラベル（契約05項目2）: Canvas テクスチャの Sprite（常にカメラ正対）。
  private labels = new Map<
    number,
    {
      sprite: THREE.Sprite;
      tex: THREE.CanvasTexture;
      mat: THREE.SpriteMaterial;
      key: string;
      basePos: THREE.Vector3; // クランプ前の基準位置（縦画面の画面内収納に使う・項目4）
    }
  >();

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
    this.attachCameraControls();

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
    this.particles.setBloomLayer(BLOOM_LAYER); // エフェクト粒子を選択的Bloomの対象に（カードは非対象）

    this.buildEnvironment();
    this.buildDropIndicators();

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
    this.viewYou = view.youIndex;
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
          // 表示順に整列（連番はランク順・組はスート順）。core のメルドは不変に保つ（E8）。
          orderedMeldCards(meld).forEach((card, k) => {
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

    // カメラを現手番（=youIndex）席の背後へ演出移動。ただしユーザーが視点を操作中は勝手に戻さない
    // （契約07項目1: リセットはユーザー操作で。ラウンド切替=clearCards で自動的に既定へ復帰する）。
    if (!this.userControlled) this.aimCameraAt(view.youIndex);
    // 手番スポットは「現手番の席」を照らす（通信対戦では youIndex と別席になり得る）
    const curSeat = view.seats.find((s) => s.isCurrent)?.index ?? view.youIndex;
    this.setActiveSeat(curSeat);
    this.updateLabels(view); // 席名ビルボード（手番強調はテクスチャ再生成で反映）
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

  // ---- 3D ドロップ標的（契約05項目1: 直接D&D） -----------------------------

  private buildDropIndicators(): void {
    const mk = (rInner: number, rOuter: number, color: string): THREE.Mesh => {
      const geo = new THREE.RingGeometry(rInner, rOuter, 48);
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = TABLE_TOP_Y + 0.06;
      m.renderOrder = 8;
      m.visible = false;
      m.layers.enable(BLOOM_LAYER); // ドロップ光枠も発光として滲ませる
      this.scene.add(m);
      return m;
    };
    this.discardRing = mk(0.5, 0.66, '#ffd873'); // 捨てる = 金（2D 時代の配色を踏襲）
    this.discardRing.position.set(DISCARD_C.x, TABLE_TOP_Y + 0.06, DISCARD_C.z);
    this.fieldRing = mk(0.62, 0.8, '#37e08a'); // メルド公開 = 緑
    this.meldRingGeo = new THREE.RingGeometry(0.34, 0.46, 40); // 付け札光枠（メルドごとに材質を持つ）
  }

  /** ドラッグ開始時に全ドロップ先を同時に光らせる（E5: どこに落とすか一目で分かる）。 */
  showDropTargets(attachMeldIds: number[]): void {
    this.clearMeldRings();
    this.dropRings = [];
    this.discardRing.visible = true;
    this.dropRings.push({ mesh: this.discardRing, kind: 'discard', hot: false });
    // 場（公開）リングは現手番席のメルドゾーンへ置く（公開カードが出る場所と一致）。
    const dir = this.seatDir(this.viewYou);
    this.fieldRing.position.copy(dir).multiplyScalar(SEAT_R * 0.62);
    this.fieldRing.position.y = TABLE_TOP_Y + 0.06;
    this.fieldRing.visible = true;
    this.dropRings.push({ mesh: this.fieldRing, kind: 'field', hot: false });
    for (const id of attachMeldIds) {
      const c = this.meldCentroid(id);
      if (!c) continue;
      const mat = new THREE.MeshBasicMaterial({
        color: '#66f0b4',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(this.meldRingGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(c.x, TABLE_TOP_Y + 0.09, c.z);
      ring.renderOrder = 8;
      ring.layers.enable(BLOOM_LAYER);
      this.scene.add(ring);
      this.activeMeldRings.push(ring);
      this.dropRings.push({ mesh: ring, kind: 'meld', meldId: id, hot: false });
    }
    this.dropActive = true;
    this.wake();
  }

  /** ホバー中の標的だけを強調（拡大＋不透明度アップ）。 */
  setDropHover(target: DropTarget | null): void {
    for (const r of this.dropRings) {
      r.hot =
        target != null &&
        r.kind === target.kind &&
        (target.kind !== 'meld' || r.meldId === target.meldId);
    }
    this.wake();
  }

  hideDropTargets(): void {
    this.dropActive = false;
    this.discardRing.visible = false;
    this.fieldRing.visible = false;
    (this.discardRing.material as THREE.MeshBasicMaterial).opacity = 0;
    (this.fieldRing.material as THREE.MeshBasicMaterial).opacity = 0;
    this.clearMeldRings();
    this.dropRings = [];
    this.wake();
  }

  private clearMeldRings(): void {
    for (const m of this.activeMeldRings) {
      this.scene.remove(m);
      (m.material as THREE.Material).dispose();
    }
    this.activeMeldRings = [];
  }

  private meldCentroid(meldId: number): THREE.Vector3 | null {
    const acc = new THREE.Vector3();
    let n = 0;
    for (const obj of this.known.values()) {
      if (obj.meldId === meldId && !obj.removing) {
        acc.add(obj.targetPos);
        n++;
      }
    }
    return n === 0 ? null : acc.multiplyScalar(1 / n);
  }

  /** クライアント座標のドロップ標的を返す。優先順: メルド > 捨て札 > 場（E3: 重なり時）。 */
  dropTargetAt(clientX: number, clientY: number): DropTarget | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    // 1) メルド（レイキャスト）
    const groups: THREE.Object3D[] = [];
    for (const obj of this.known.values()) {
      if (obj.meldId != null && !obj.removing) groups.push(obj.group);
    }
    if (groups.length) {
      const hits = this.raycaster.intersectObjects(groups, true);
      for (const hit of hits) {
        let o: THREE.Object3D | null = hit.object;
        while (o && o.userData?.meldId == null) o = o.parent;
        const mid = o?.userData?.meldId;
        if (typeof mid === 'number') return { kind: 'meld', meldId: mid };
      }
    }
    // 2) 卓天板との交点から 捨て札 / 場 を判定（カメラ・リサイズに自動追従＝E3）
    const pt = this.raycaster.ray.intersectPlane(this.tablePlane, TMP_HIT);
    if (!pt) return null;
    if (Math.hypot(pt.x, pt.z) > TABLE_R) return null; // 卓外 = 取り消し（E6）
    if (Math.hypot(pt.x - DISCARD_C.x, pt.z - DISCARD_C.z) < DISCARD_R) return { kind: 'discard' };
    return { kind: 'field' };
  }

  // ---- 席名ビルボードラベル（契約05項目2） ---------------------------------

  private updateLabels(view: PlayerView): void {
    const n = view.seats.length;
    const portrait = this.aspect() < 1;
    for (const seat of view.seats) {
      const key = `${seat.name}|${seat.isCurrent ? 1 : 0}`;
      let L = this.labels.get(seat.index);
      if (!L) {
        const tex = this.makeLabelTexture(seat.name, seat.isCurrent);
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
        const sprite = new THREE.Sprite(mat);
        this.scene.add(sprite);
        L = { sprite, tex, mat, key, basePos: new THREE.Vector3() };
        this.labels.set(seat.index, L);
      } else if (L.key !== key) {
        L.tex.dispose();
        L.tex = this.makeLabelTexture(seat.name, seat.isCurrent);
        L.mat.map = L.tex;
        L.mat.needsUpdate = true;
        L.key = key;
      }
      // 自席ラベルは非表示（項目5: 自分の席は画面下の扇形手札で自明）。
      // ホットシートでは youIndex が手番ごとに変わるため、手番席のラベルが隠れる（意図どおり）。
      if (seat.index === view.youIndex) {
        L.sprite.visible = false;
        continue;
      }
      const dir = this.seatDir(seat.index);
      // 縦画面は視野が狭く上端で見切れやすいので、半径・高さを控えめにする（項目4）。
      L.basePos.copy(dir).multiplyScalar(SEAT_R * (portrait ? 1.0 : 1.12));
      L.basePos.y = TABLE_TOP_Y + (portrait ? 0.58 : 0.72);
      L.sprite.position.copy(L.basePos);
      const s = seat.isCurrent ? 1.18 : 1.0;
      L.sprite.scale.set(1.3 * s, 0.46 * s, 1);
      L.sprite.visible = true;
    }
    // 席数が減った場合（次ゲームの人数変更等）は余ったラベルを隠す
    for (const [idx, L] of this.labels) if (idx >= n) L.sprite.visible = false;
    this.clampLabels();
  }

  /**
   * 席名ラベルを画面内に収める（項目2・4）。基準位置を投影し、上下端を超える分は
   * ワールド Y を上下させ、左右端（|NDC.x|>SIDE）を超える分はカメラ右方向（水平面）へ
   * 押し戻す。縦画面で左右席のラベルがはみ出す問題（R7 の上端クランプだけでは不足）を解消する。
   * 端に寄せることで席の左右方向は保たれるため、どの席のラベルかは判別できる。
   * カメラのイージング追従（およびユーザーのオービット）に合わせて毎フレーム呼ぶ。
   */
  private clampLabels(): void {
    const TOP = 0.9; // NDC 上端マージン（1.0=画面端）
    const BOT = -0.92; // NDC 下端マージン
    const SIDE = 0.94; // NDC 左右端マージン（|x|>SIDE で内側へ引き戻す）
    const STEP = 0.25; // 投影勾配を推定するプローブ量（ワールド単位）
    this.camera.updateMatrixWorld();
    // カメラ右ベクトル（水平面成分）。ラベルを画面水平方向へ押し戻すための移動軸。
    const right = TMP_R.setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.y = 0;
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    for (const L of this.labels.values()) {
      if (!L.sprite.visible) continue;
      L.sprite.position.copy(L.basePos);
      // 縦方向: 上端超過は下げ、下端超過は上げる（プローブで勾配を線形推定）。
      let p = TMP_A.copy(L.sprite.position).project(this.camera);
      if (p.y > TOP || p.y < BOT) {
        const target = p.y > TOP ? TOP : BOT;
        const p2 = TMP_B.copy(L.sprite.position).setY(L.sprite.position.y - STEP).project(this.camera);
        const slope = (p.y - p2.y) / STEP; // dNDC.y / dWorldY
        if (Math.abs(slope) > 1e-3) L.sprite.position.y += (target - p.y) / slope;
      }
      // 横方向: 左右端超過はカメラ右方向へ押し戻す（縦補正後の位置で再投影）。
      p = TMP_A.copy(L.sprite.position).project(this.camera);
      if (Math.abs(p.x) > SIDE) {
        const p3 = TMP_B.copy(L.sprite.position).addScaledVector(right, STEP).project(this.camera);
        const slope = (p3.x - p.x) / STEP; // dNDC.x / d(along right)
        if (Math.abs(slope) > 1e-4) {
          const targetX = Math.sign(p.x) * SIDE;
          L.sprite.position.addScaledVector(right, (targetX - p.x) / slope);
        }
      }
    }
  }

  private makeLabelTexture(name: string, current: boolean): THREE.CanvasTexture {
    const W = 256;
    const H = 88;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const pad = 8;
    const r = 20;
    roundRectPath(ctx, pad, pad, W - 2 * pad, H - 2 * pad, r);
    ctx.fillStyle = current ? 'rgba(216,161,58,0.94)' : 'rgba(14,22,33,0.86)';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = current ? 'rgba(255,236,170,0.98)' : 'rgba(120,160,210,0.55)';
    ctx.stroke();
    ctx.fillStyle = current ? '#201603' : '#eef3fa';
    ctx.font = '700 34px system-ui, "Hiragino Kaku Gothic ProN", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(ellipsize(ctx, name || '?', W - 44), W / 2, H / 2 + 1);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return tex;
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

  /** メルド公開の決め演出: 金色の大型スパーク + 二重光輪 + 打ち上げの粉塵 + カメラパンチ（契約09項目2）。 */
  publishEffect(seatIndex: number): void {
    const p = this.seatSpot(seatIndex);
    // 発光スパーク（数・初速・寿命を増強）+ 上方へ吹き上げる金の火の粉
    this.particles.burst(p, { count: 52, color: [1, 0.85, 0.4], speed: 3.0, size: 0.13, life: 0.95 });
    this.particles.burst(p, { count: 22, color: [1, 0.95, 0.62], speed: 4.4, size: 0.08, life: 1.2, spread: 0.15, gravity: 0.6 });
    // 二重光輪（芯の速いリング + 外へ広がる余波リング）
    this.spawnRing(p, '#ffe6a0', { r1: 2.2, dur: 0.5, opacity: 1.0 });
    this.spawnRing(p, '#ffd873', { r1: 3.4, dur: 0.8, opacity: 0.7, delay: 0.09 });
    this.cameraPunch(0.7);
    this.wake();
  }

  /** ポン/チーの鳴き演出: 種別で色分けした大型スパーク + 二重光輪 + 強めのカメラパンチ（契約09項目2）。 */
  claimEffect(seatIndex: number, kind: 'pon' | 'chi'): void {
    const p = this.seatSpot(seatIndex);
    const color: [number, number, number] = kind === 'pon' ? [1, 0.45, 0.3] : [0.4, 0.72, 1];
    const ringA = kind === 'pon' ? '#ff9a6a' : '#8fd0ff';
    const ringB = kind === 'pon' ? '#ff7a4d' : '#66b6ff';
    this.particles.burst(p, { count: 64, color, speed: 3.6, size: 0.14, life: 0.95, spread: 1 });
    this.particles.burst(p, { count: 24, color, speed: 5.0, size: 0.09, life: 0.7, spread: 0.2, gravity: 0.5 });
    this.spawnRing(p, ringA, { r1: 2.4, dur: 0.5, opacity: 1.0 });
    this.spawnRing(p, ringB, { r1: 3.8, dur: 0.85, opacity: 0.7, delay: 0.1 });
    this.cameraPunch(1.05);
    this.wake();
  }

  /** 上がり/ラウンド終了のセレブレーション: 紙吹雪噴水 + 金スパーク噴水 + 三重光輪 + カメラパンチ（契約09項目2）。 */
  celebrate(seatIndex: number): void {
    const p = this.seatSpot(seatIndex, 0.4);
    const fountain = new THREE.Vector3(0, TABLE_TOP_Y + 0.2, 0);
    // 紙吹雪を大増量（キャップ内）。虹色×多量で Bloom 無効なモバイルでも見た目に派手（E2）。
    this.particles.confettiFountain(fountain, Math.min(this.quality.confettiCap, 400));
    // 金の噴水スパーク + 席前の放射バースト
    this.particles.burst(fountain, { count: 40, color: [1, 0.92, 0.55], speed: 5.2, size: 0.12, life: 1.3, spread: 0.35, gravity: 0.8 });
    this.particles.burst(p, { count: 56, color: [1, 0.9, 0.5], speed: 3.6, size: 0.15, life: 1.2 });
    // 卓中央から広がる三重の祝祭リング（時間差で波状に）
    this.spawnRing(fountain, '#fff0c0', { r1: 2.6, dur: 0.6, opacity: 1.0 });
    this.spawnRing(fountain, '#ffe08a', { r1: 4.0, dur: 0.9, opacity: 0.78, delay: 0.12 });
    this.spawnRing(fountain, '#ffd066', { r1: 5.2, dur: 1.15, opacity: 0.55, delay: 0.26 });
    this.cameraPunch(1.25);
    this.wake();
  }

  /** カメラのドリーパンチ（減衰）。reduced-motion 時はシェイクを伴わない（quality.cameraShake）。 */
  cameraPunch(intensity: number): void {
    this.camKick = Math.max(this.camKick, intensity);
    this.wake();
  }

  private spawnRing(
    pos: THREE.Vector3,
    color: string,
    opts: { r0?: number; r1?: number; dur?: number; opacity?: number; delay?: number } = {},
  ): void {
    if (this.rings.length >= MAX_RINGS) {
      const old = this.rings.shift();
      if (old) {
        this.scene.remove(old.mesh);
        (old.mesh.material as { dispose?: () => void }).dispose?.();
      }
    }
    const op = opts.opacity ?? 0.85;
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(pos);
    mesh.renderOrder = 9;
    mesh.layers.enable(BLOOM_LAYER); // 光輪は発光として滲ませる（選択的Bloomの対象）
    this.scene.add(mesh);
    // delay<0 の間は待機（opacity 0）。二重・三重リングを時間差で波状に出すため。
    this.rings.push({ mesh, t: -(opts.delay ?? 0), dur: opts.dur ?? 0.55, r0: opts.r0 ?? 0.2, r1: opts.r1 ?? 2.6, op });
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

  // ---- ユーザーカメラ操作（契約07項目1: ピンチズーム / スワイプ軌道回転） --------
  // 3D キャンバス上のポインタのみを扱う。手札 D&D は handEl がポインタキャプチャするため
  // ここには届かず、住み分けは自動的に成立する（手札を卓へドラッグ中はカメラを動かさない）。
  private attachCameraControls(): void {
    const el = this.renderer.domElement as HTMLElement;
    el.style.touchAction = 'none'; // ピンチでページ全体がズームしないように（E5）

    const orbitFromDelta = (dx: number, dy: number): void => {
      this.ensureUserControl();
      this.orbitYaw -= dx * ORBIT_YAW_SENS;
      this.orbitPitch = clamp(this.orbitPitch - dy * ORBIT_PITCH_SENS, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH);
      this.applyOrbit();
    };
    const zoomBy = (factor: number): void => {
      this.ensureUserControl();
      this.orbitRadius = clamp(this.orbitRadius * factor, MIN_ORBIT_R, MAX_ORBIT_R);
      this.applyOrbit();
    };

    this.onCamPointerDown = (e: PointerEvent): void => {
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinchDist = this.currentPinchDist();
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    this.onCamPointerMove = (e: PointerEvent): void => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const nx = e.clientX;
      const ny = e.clientY;
      this.pointers.set(e.pointerId, { x: nx, y: ny });
      if (this.pointers.size >= 2) {
        // ピンチズーム（2本指）: 指間距離の比で半径を増減（E5・タッチ合成で検証）。
        const d = this.currentPinchDist();
        if (this.pinchDist > 0 && d > 0) zoomBy(this.pinchDist / d);
        this.pinchDist = d;
      } else {
        // スワイプ（1本指 / マウスドラッグ）: 方位・仰角のオービット。
        orbitFromDelta(nx - prev.x, ny - prev.y);
      }
      e.preventDefault();
    };
    this.onCamPointerUp = (e: PointerEvent): void => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      // 2→1 本へ減った時に残指を基準へ取り直し、ピンチ↔オービット遷移のジャンプを防ぐ（E9）。
      this.pinchDist = this.pointers.size === 2 ? this.currentPinchDist() : 0;
      el.releasePointerCapture?.(e.pointerId);
    };
    this.onCamWheel = (e: WheelEvent): void => {
      zoomBy(Math.exp(e.deltaY * 0.0012)); // ホイールズーム（マウス）
      e.preventDefault();
    };

    el.addEventListener('pointerdown', this.onCamPointerDown);
    el.addEventListener('pointermove', this.onCamPointerMove);
    el.addEventListener('pointerup', this.onCamPointerUp);
    el.addEventListener('pointercancel', this.onCamPointerUp);
    el.addEventListener('wheel', this.onCamWheel, { passive: false });

    // 合格基準のタッチ合成検証で参照する読み取り専用アクセサ（描画層内で完結）。
    // hidden ペインでは rAF が止まり loop の settle が走らないため、呼び出し時にカメラを
    // 目標へスナップし clampLabels を再実行してから「落ち着いた既定/オービット視点」を報告する
    // （SKILL: カメラ検証は手動 settle で）。labels は各席ラベルのクランプ後 NDC。
    (el as unknown as { __cameraState?: () => unknown }).__cameraState = () => {
      this.camPos.copy(this.camPosGoal);
      this.camTarget.copy(this.camTargetGoal);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      this.camera.updateMatrixWorld();
      this.clampLabels();
      const labels: { index: number; visible: boolean; ndc: number[] }[] = [];
      for (const [index, L] of this.labels) {
        const n = TMP_A.copy(L.sprite.position).project(this.camera);
        labels.push({ index, visible: !!L.sprite.visible, ndc: [n.x, n.y] });
      }
      return {
        pos: this.camera.position.toArray(),
        posGoal: this.camPosGoal.toArray(),
        target: this.camTargetGoal.toArray(),
        radius: this.orbitRadius,
        yaw: this.orbitYaw,
        pitch: this.orbitPitch,
        user: this.userControlled,
        labels,
      };
    };
    // 検証用: 卓面ワールド点(x,0,z)を現カメラで画面座標へ投影し、その座標で dropTargetAt を
    // 逆引きする。オービット後もレイキャストがカメラへ追従する（E3）ことの確認に使う。
    (el as unknown as { __dropProbe?: (x: number, z: number) => unknown }).__dropProbe = (x, z) => {
      const rect = el.getBoundingClientRect();
      const p = TMP_B.set(x, TABLE_TOP_Y + 0.04, z).project(this.camera);
      const cx = rect.left + ((p.x + 1) / 2) * rect.width;
      const cy = rect.top + ((1 - p.y) / 2) * rect.height;
      return { client: [Math.round(cx), Math.round(cy)], target: this.dropTargetAt(cx, cy) };
    };
  }

  private currentPinchDist(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0]!.x - pts[1]!.x, pts[0]!.y - pts[1]!.y);
  }

  /** 初回のユーザー操作で、現在の見た目のカメラ姿勢からオービット状態を取り込む（滑らかな引き継ぎ）。 */
  private ensureUserControl(): void {
    if (this.userControlled) return;
    this.userControlled = true;
    const off = TMP_A.subVectors(this.camPos, this.camTarget);
    const r = off.length() || 7.4;
    this.orbitRadius = clamp(r, MIN_ORBIT_R, MAX_ORBIT_R);
    this.orbitPitch = clamp(Math.asin(clamp(off.y / r, -1, 1)), MIN_ORBIT_PITCH, MAX_ORBIT_PITCH);
    this.orbitYaw = Math.atan2(off.z, off.x);
    this.orbitTarget.copy(this.camTarget);
  }

  /** オービット状態（半径・方位・仰角・注視点）からカメラ目標を更新する。loop が滑らかに追従する。 */
  private applyOrbit(): void {
    const cosP = Math.cos(this.orbitPitch);
    this.camPosGoal.set(
      this.orbitTarget.x + this.orbitRadius * cosP * Math.cos(this.orbitYaw),
      this.orbitTarget.y + this.orbitRadius * Math.sin(this.orbitPitch),
      this.orbitTarget.z + this.orbitRadius * cosP * Math.sin(this.orbitYaw),
    );
    this.camTargetGoal.copy(this.orbitTarget);
    this.wake();
  }

  /** 自席の既定視点へ戻す（HUDのリセットボタンから呼ぶ・契約07項目1）。 */
  resetView(): void {
    this.userControlled = false;
    this.pointers.clear();
    this.pinchDist = 0;
    this.aimCameraAt(this.viewYou);
    this.wake();
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

    // 席名ラベルの画面内クランプ（カメラのイージングに追従・項目4）
    this.clampLabels();

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
      if (r.t < 0) {
        // 開始ディレイ待ち（時間差の波状リング）。まだ見せない。
        r.mesh.material.opacity = 0;
        fxBusy = true;
        continue;
      }
      const u = r.t / r.dur;
      if (u >= 1) {
        this.scene.remove(r.mesh);
        (r.mesh.material as { dispose?: () => void }).dispose?.();
        this.rings.splice(i, 1);
        continue;
      }
      const ease = 1 - (1 - u) * (1 - u); // easeOutQuad
      r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * ease);
      r.mesh.material.opacity = r.op * (1 - u);
      fxBusy = true;
    }

    // パーティクル
    if (this.particles.update(dt)) fxBusy = true;

    // 3D ドロップ標的の脈動（ドラッグ中のみ・ホバー標的は強調）
    if (this.dropActive) {
      const puls = 0.34 + 0.22 * (0.5 + 0.5 * Math.sin(now * 0.005));
      for (const r of this.dropRings) {
        const mat = r.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = r.hot ? 0.95 : puls;
        r.mesh.scale.setScalar(r.hot ? 1.16 : 1.0);
      }
      fxBusy = true;
    }

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
    // 新ラウンドは既定視点から始める（項目1: ラウンド開始の自動カメラ演出を維持）。
    this.userControlled = false;
    this.pointers.clear();
    this.pinchDist = 0;
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;

    // カメラ操作のイベントリスナ / 検証アクセサを解除（リーク防止）。
    const cel = this.renderer.domElement as HTMLElement;
    cel.removeEventListener('pointerdown', this.onCamPointerDown);
    cel.removeEventListener('pointermove', this.onCamPointerMove);
    cel.removeEventListener('pointerup', this.onCamPointerUp);
    cel.removeEventListener('pointercancel', this.onCamPointerUp);
    cel.removeEventListener('wheel', this.onCamWheel);
    delete (cel as unknown as { __cameraState?: () => unknown }).__cameraState;

    // 演出資源（コンテキストロスト対策・E11）: 光輪 → パーティクル → コンポーザ → 環境マップ
    for (const r of this.rings) {
      this.scene.remove(r.mesh);
      (r.mesh.material as { dispose?: () => void }).dispose?.();
    }
    this.rings.length = 0;
    this.ringGeo.dispose?.();
    // ドロップ標的・席名ラベル（Canvas テクスチャは traverse が解放しないため明示 dispose・E8）
    this.clearMeldRings();
    this.meldRingGeo?.dispose?.();
    for (const L of this.labels.values()) {
      this.scene.remove(L.sprite);
      L.tex.dispose();
      L.mat.dispose();
    }
    this.labels.clear();
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
const TMP_B = new THREE.Vector3(); // clampLabels の投影勾配推定用
const TMP_R = new THREE.Vector3(); // clampLabels のカメラ右ベクトル（水平押し戻し軸）
const TMP_HIT = new THREE.Vector3(); // dropTargetAt の交点用（ポインタ処理とループは同時実行されない）

/** 値を [lo, hi] に丸める（オービットのズーム/仰角クランプ用）。 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return h;
}

/** 角丸矩形のパスを引く（ラベル背景用）。 */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 幅 maxW に収まるよう末尾を省略（…）する。長い名前でも破綻しない（項目2）。 */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}
