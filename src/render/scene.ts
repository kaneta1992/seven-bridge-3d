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
import { CARD_H, CARD_W, centerKeepout, layoutSeatMelds, type MeldInput } from './meldLayout';
import { orderedMeldCards } from './meldSort';
import { ParticleSystem } from './particles';
import { BLOOM_LAYER, createPostFX, type PostFX } from './postfx';
import { detectQuality, type QualityTier } from './quality';

// CARD_W / CARD_H は meldLayout と単一ソース化（配置の純粋関数と 3D で同じ寸法を使う・契約11）。
const CARD_D = 0.02;
const TABLE_TOP_Y = 0;
const SEAT_R = 2.55; // 席の半径
const HAND_SPACING = 0.52;
const EASE_SPEED = 7.5; // 補間の速さ（大きいほど機敏）
const DEAL_STEP_MS = 42; // 配札スタッガ（1枚ごとの遅延）
const MAX_RINGS = 10; // 光輪（ショックウェーブ）の同時上限（派手化で二重リングを出すため増量・契約09項目2）
const DISCARD_C = new THREE.Vector3(-0.5, TABLE_TOP_Y, 0); // 捨て札の山の中心（update と一致）
// 山札カードの向き（卓に伏せて水平・面下）。毎フレームの Euler 生成を避け共有する。
const DECK_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const DISCARD_R = 0.62; // 捨て札ドロップ判定の半径（山札 +0.5 と干渉しない大きさ）
const TABLE_R = 3.5; // 卓天板の半径（この外へのドロップは卓外＝取り消し）

// ユーザーカメラ操作（契約07項目1）: 卓中心まわりのオービット。ズーム=半径、スワイプ=方位/仰角。
const MIN_ORBIT_R = 3.4; // ズーム最接近（卓面へ寄れる下限・クリッピング回避）
const MAX_ORBIT_R = 13.0; // ズーム最遠（全卓俯瞰の上限・fog 手前に収める）
const MIN_ORBIT_PITCH = 0.14; // 仰角下限（卓すれすれ・約8°。遠い席名を見に行ける）
const MAX_ORBIT_PITCH = 1.45; // 仰角上限（ほぼ真上・約83°。卓が裏返らない）
const ORBIT_YAW_SENS = 0.006; // 方位感度（rad/px）
const ORBIT_PITCH_SENS = 0.006; // 仰角感度（rad/px）
// 捨て札タップ判定（契約14項目2/E2）: これ以上動いたらスワイプ、これ以上時間がかかったら長押し扱い。
const TAP_MOVE_MAX = 8; // px（手札 D&D の並び替え閾値と同値・一貫）
const TAP_TIME_MAX = 500; // ms

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
  targetScale: number; // 目標スケール（メルドは席の混み具合で段階縮小・契約11。非メルドは1）
  meldId?: number; // 面カードが 3D メルドに属する場合の所属メルドID（レイキャスト付け札用・R4項目5）
  spawnPos: THREE.Vector3; // 出現時の出発点（飛翔のスポーン元・契約14項目5の検証用に保持）
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
  // 匿名の裏カード（他家手札・山札）を安定 ID で管理する（項目3/4/6・2026-08-11 再設計）。
  //   キー: 手札 = `h:<席>:<スロット>` / 山札 = `d:<段>`。
  //   席や枚数が変わっても同じスロットは同一オブジェクトが追従するため、手番交代のたびに
  //   カードが卓上を横断して「山札へ吸い込まれる」誤読を防ぐ（退場はその場フェード）。
  private backById = new Map<string, CardObj>();
  // 直近フレームの他家手札枚数（席index→枚数）。+1 検出で他家ツモの山札→手札飛翔を起動する（項目3）。
  private backSeatCount = new Map<number, number>();

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
  // WebGL コンテキストロスト対応（項目11）: ロスト検知でループを止め復帰案内を出す。
  private onContextLost!: (e: Event) => void;
  private onContextRestored!: (e: Event) => void;
  private lostNoticeEl: HTMLElement | null = null;

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
  // ドラッグ中カードが付け札可能なメルドID集合（項目15b: dropTargetAt のメルド判定をこれに限定）。
  private attachableMelds = new Set<number>();
  // メルドごとの卓面外接矩形（ゾーン判定用・2026-08-11）。update() の配置時に再構築する。
  private meldBounds = new Map<number, { minX: number; maxX: number; minZ: number; maxZ: number }>();
  private handDragging = false; // 手札 D&D 中はカメラ操作を無視する（項目10）。

  // ホットシートの手番交代でカメラを自席へリセット（契約14項目3）。youIndex は「操作者＝視点席」で、
  // ホットシートは手番ごとに変わる（通信対戦は自席固定で不変）。前回と変わったら userControlled を
  // 解除して aimCameraAt(youIndex) に戻す＝通信対戦では発火しない（youIndex 不変）ので現状維持になる。
  private prevYouIndex = -1;
  // 直近 update の現手番席（＝捨て札の出所推定に使う。鳴きウィンドウ外では claimWindow が無いため、
  // 「前フレームで手番だった席」を捨てた席とみなす・契約14項目5）。
  private prevCurSeat = -1;
  // カメラが回り込んで視界を塞ぐ他家の浮遊手札（席index集合）。毎フレーム判定しヒステリシスで切替（項目4）。
  private blockedSeats = new Set<number>();
  // 3D 捨て札の山をタップしたときのコールバック（履歴ポップアップ・契約14項目2）。app.ts が登録する。
  private onDiscardTap: (() => void) | null = null;
  // タップ判定の候補（カメラ操作/手札D&Dと区別。移動閾値内・短時間・単一ポインタのみタップ成立・E2）。
  private tapCand: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;

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
    this.attachContextLossHandlers();

    this.scene = new THREE.Scene();
    // 部屋の空間感（契約14項目1）: 暖色の壁色をフォグ/背景に用い、囲われた「明るい家の部屋」に見せる。
    // 壁メッシュが視界を覆うため背景色は隙間の保険。フォグ遠方を壁半径に合わせ、壁が奥へ自然に溶ける。
    // ティアを問わず暖色を明るめに保つ（低ティアは buildRoom の窓/ランプを省くため、この地色と
    // buildEnvironment の環境光を明るくして「暗い部屋」に落ちないようにする）。
    this.scene.background = new THREE.Color('#33271a');
    this.scene.fog = new THREE.Fog('#40301f', 13, 34);
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
    // 裏面（他家の空中手札・山札）は席の外側＝暗い壁を向くためキー/フィル光が当たりにくく暗く沈む
    // （契約14項目7）。裏面テクスチャを弱い emissive として自発光させ、光の向きに依存せず柄が明るく
    // 読めるようにする（emissiveMap = 同じ裏面テクスチャなので柄の陰影は保ったまま底上げされる）。
    const backTex = backTexture();
    this.backMat = new THREE.MeshPhysicalMaterial({
      map: backTex,
      emissive: new THREE.Color('#ffffff'),
      emissiveMap: backTex,
      emissiveIntensity: 0.42,
      roughness: 0.42,
      metalness: 0.05,
      clearcoat: 0.5,
      clearcoatRoughness: 0.3,
      envMapIntensity: 0.5,
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
    // 3灯構成（キー+リム+フィル）+ 半球/環境光 + 手番スポット。暖色寄りの「明るい家の部屋」（契約14項目1）。
    // 環境光/半球光を全ティア共通で明るめに設定し、低ティア（buildRoom で窓/ランプを省くモバイル）でも
    // 部屋が暗く沈まないようにする。ここは方向を持たない照明なので、席の外を向く裏面手札（項目7）にも効く。
    this.scene.add(new THREE.AmbientLight(0xfff1dc, 0.62));
    // 半球光: 天井の暖色 ↓ 床の木色。冷たいスタジオ感を弱め室内の温かみを出す。
    this.scene.add(new THREE.HemisphereLight(0xffe8c8, 0x4a3826, 0.78));
    this.buildRoom();

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

    // 卓下の影の受け皿（部屋の床の上に敷く円盤・暖色の木調に寄せる）
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 48),
      new THREE.MeshStandardMaterial({ color: '#2a1d12', roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.45;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  /**
   * 家の部屋風の囲い（項目7）: 内向き（BackSide）の箱で床・壁・天井を作り、暖色の環境に見せる。
   * 全メッシュは既定レイヤ(0)のまま＝選択的 Bloom（レイヤ1のみ黒背景抽出）には一切載らない（E3）。
   * カード視認性を損なわないよう壁は暗めの暖色。モバイル（low ティア）では窓/据置ライトを省き軽量化。
   */
  private buildRoom(): void {
    const S = 34; // 部屋の一辺
    const H = 13; // 天井高
    const floorY = -0.5;
    // BoxGeometry の面順: +x, -x, +y(天井), -y(床), +z, -z。面ごとに材質を割り当てる。
    const wall = (color: string): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.96, metalness: 0, side: THREE.BackSide });
    const wallMat = wall('#6b5540'); // 壁: 暖色の塗り壁/板（明るい家の部屋・契約14項目1）
    const ceilMat = wall('#4a3a2a'); // 天井: 壁より一段暗い暖色
    const floorMat = new THREE.MeshStandardMaterial({ color: '#5a4530', roughness: 0.98, side: THREE.BackSide }); // 床板
    const mats = [wallMat, wallMat.clone(), ceilMat, floorMat, wallMat.clone(), wallMat.clone()];
    const room = new THREE.Mesh(new THREE.BoxGeometry(S, H, S), mats);
    room.position.set(0, floorY + H / 2, 0);
    room.receiveShadow = false; // 内壁は影計算に含めない（コスト削減・見た目に不要）
    this.scene.add(room);

    if (this.quality.name === 'low') {
      // モバイル（低ティア）は窓/据置ランプの追加ジオメトリ・点光源を省いて軽量化するが、
      // 明るさ・暖かみは落とさない（契約14項目1）。方向を持たない安価な暖色フィルを1灯だけ足し、
      // 卓と裏面手札を上方から満遍なく持ち上げる（影・追加メッシュなしでコストはほぼゼロ）。
      const softFill = new THREE.DirectionalLight(0xffe6c2, 0.55);
      softFill.position.set(0, 9, 2);
      this.scene.add(softFill);
      return;
    }

    // 窓（-z 壁に暖色の外光パネル）: 発光は MeshBasic（Bloom 非対象レイヤ0）で表現。夕方の家の窓。
    const winW = 5.4;
    const winH = 4.2;
    const win = new THREE.Mesh(
      new THREE.PlaneGeometry(winW, winH),
      new THREE.MeshBasicMaterial({ color: '#ffcf8f' }),
    );
    win.position.set(-4, floorY + 4.6, -S / 2 + 0.06); // 壁のすぐ内側
    this.scene.add(win);
    // 窓桟（十字の暗いフレーム）で「窓」らしさを補強。
    const frameMat = new THREE.MeshBasicMaterial({ color: '#2a1c10' });
    const barV = new THREE.Mesh(new THREE.PlaneGeometry(0.16, winH), frameMat);
    barV.position.set(win.position.x, win.position.y, win.position.z + 0.02);
    this.scene.add(barV);
    const barH = new THREE.Mesh(new THREE.PlaneGeometry(winW, 0.16), frameMat);
    barH.position.copy(barV.position);
    this.scene.add(barH);

    // 窓からの暖色の指向性光 + 部屋の据置ランプ（点光源）。カードのキー光は既存 key に任せ、
    // これらは環境の温かみを足すだけの弱め設定（視認性を損なわない）。
    const windowLight = new THREE.DirectionalLight(0xffcf94, 0.35);
    windowLight.position.set(-4, floorY + 4.6, -6);
    windowLight.target.position.set(0, 0, 0);
    this.scene.add(windowLight);
    this.scene.add(windowLight.target);
    const lamp = new THREE.PointLight(0xffb066, 14, 16, 2);
    lamp.position.set(6.5, floorY + 5.5, 5.5);
    this.scene.add(lamp);
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

  /**
   * 他家手札を「人が持っているように」席の空中へ扇状で浮かせる（項目6）。卓面より高い Y に上げ、
   * 席方向へ立てて傾けることで、卓面のメルドゾーンや伏せ札と物理的に干渉しない。手の造形は無し。
   * 返す quat は裏面（backTexture）が卓の外側＝その席のプレイヤー側から見えない向き＝観戦者からは
   * 裏が見える向き。扇はカード面内のロール（Z）で広げる。
   */
  private floatHandLayout(seatIndex: number, count: number): { pos: THREE.Vector3; quat: THREE.Quaternion }[] {
    const dir = this.seatDir(seatIndex);
    const tangent = new THREE.Vector3(-dir.z, 0, dir.x);
    const a = this.seatAngle(seatIndex);
    const height = TABLE_TOP_Y + 0.98; // 卓面から浮かせる高さ（メルド・伏せ札と非干渉）
    const anchor = dir.clone().multiplyScalar(SEAT_R + 0.05).setY(height);
    // 枚数が増えても幅が暴走しないよう間隔を詰める（扇の総幅を一定に保つ）。
    const spacing = count > 1 ? Math.min(HAND_SPACING, 2.6 / (count - 1)) : 0;
    const tilt = 1.12; // 卓面（-π/2）から立てる角度。カードを手前に起こして持ち手風に。
    const out: { pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];
    for (let k = 0; k < count; k++) {
      const t = k - (count - 1) / 2;
      const roll = t * 0.12; // 面内ロールで扇状に広げる
      const p = anchor
        .clone()
        .addScaledVector(tangent, t * spacing)
        .add(new THREE.Vector3(0, -Math.abs(t) * 0.02, 0)) // 端ほど僅かに下げ弧を描く
        .addScaledVector(dir, Math.abs(t) * 0.02); // 端ほど僅かに外へ膨らむ
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2 + tilt, -a + Math.PI / 2, roll, 'YXZ'));
      out.push({ pos: p, quat: q });
    }
    return out;
  }

  // ---- カード移動の飛翔の出発点（契約14項目5: 完全トレーサビリティ） ------------
  // 新規に現れる面カード（捨て札・メルド公開・付け札）を、その操作者の位置から飛ばすための出発点。
  // 自席（viewYou）の操作は画面下の 2D 手札に対応する卓手前の低い位置から、他家の操作はその席の
  // 空中手札（floatHandLayout のアンカー相当）から出す。place() の spawnPos に渡すと、山札から沸くのでなく
  // 「誰の手から出たか」が軌跡で追える（通信対戦でもスナップショット差分で新規カードとして検出される）。

  /** 自席の 2D 手札に対応する卓手前の低い出発点（画面下から立ち上がる飛翔に見える）。 */
  private selfHandSpot(): THREE.Vector3 {
    const dir = this.seatDir(this.viewYou);
    return dir.clone().multiplyScalar(SEAT_R + 0.5).setY(TABLE_TOP_Y + 0.28);
  }

  /** 他家の空中手札のアンカー（floatHandLayout と同じ席前の高さ）。 */
  private floatHandSpot(seat: number): THREE.Vector3 {
    const dir = this.seatDir(seat);
    return dir.clone().multiplyScalar(SEAT_R + 0.05).setY(TABLE_TOP_Y + 0.98);
  }

  /** 操作者席に応じた出発点（自席=2D手札位置 / 他家=空中手札）。 */
  private actorSpot(seat: number): THREE.Vector3 {
    return seat === this.viewYou ? this.selfHandSpot() : this.floatHandSpot(seat);
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

    // 2) メルド（面表示）: 所有者席の扇形セクタ内へ配置する（契約11 = 再設計）。
    //    配置は純粋関数 layoutSeatMelds に委譲する（DOM/three 非依存で数値検証可能）:
    //     - 最内行を中央保護ゾーンの床に置き、段は外周方向へ折り返す＝山札/捨て札へ絶対に侵入しない
    //     - 各カードを席の角度セクタ内へ収める＝隣席のメルドと重ならない
    //     - 収まらなければカードを段階縮小（scale）／長いメルドは行を跨いで折り返す
    //    全メルドカードへ単調増加の微小 y を与えて共面（Z-fighting）を防ぐ。
    const meldsBySeat = new Map<number, Meld[]>();
    for (const meld of view.melds) {
      const seat = seatIndexById.get(meld.owner) ?? view.youIndex;
      const arr = meldsBySeat.get(seat) ?? [];
      arr.push(meld);
      meldsBySeat.set(seat, arr);
    }
    let ySeq = 0; // 全メルドカード通し番号（y 段差用）
    this.meldBounds.clear(); // ゾーン判定用の外接矩形を作り直す（2026-08-11 付け札ヒット改善）
    for (const [seat, melds] of meldsBySeat) {
      const dir = this.seatDir(seat);
      const tangent = new THREE.Vector3(-dir.z, 0, dir.x);
      const quat = this.flatQuat(seat, 0, true);
      // 表示順に整列したカード列をメルドID→配列で引けるようにする（core のメルドは不変・E8）。
      const orderedById = new Map<number, Card[]>();
      const inputs: MeldInput[] = melds.map((m) => {
        const cards = orderedMeldCards(m);
        orderedById.set(m.id, cards);
        return { id: m.id, count: cards.length };
      });
      // 自席（viewYou）は「手札帯より上」へ寄せる自席専用レイアウト（控えめバルジ+段数最小化・項目1a）。
      const layout = layoutSeatMelds(this.seatCount, dir.x, inputs, seat === this.viewYou);
      const halfW = (Math.max(CARD_W, CARD_H) / 2) * layout.scale;
      // 公開/付け札で新規に現れるメルドカードは、所有者席の手（自席=2D手札位置 / 他家=空中手札）から
      // 飛ばす（契約14項目5）。既存カードの再配置では spawnPos は無視されるため軌跡に影響しない。
      const meldSpawn = this.actorSpot(seat);
      for (const slot of layout.slots) {
        const card = orderedById.get(slot.meldId)?.[slot.index];
        if (!card) continue;
        const id = cardId(card);
        desired.add(id);
        const p = dir
          .clone()
          .multiplyScalar(slot.u)
          .addScaledVector(tangent, slot.v)
          .add(new THREE.Vector3(0, TABLE_TOP_Y + 0.05 + ySeq * 0.006, 0));
        ySeq++;
        this.place(id, card, p, quat, now, 0, meldSpawn, slot.meldId, layout.scale);
        // ゾーン判定用にメルドの外接矩形（卓面 x/z）を蓄積。カードメッシュへの厳密レイキャストが
        // 縮小カードやリング表示とのズレで外れても、矩形内ドロップなら付け札として拾えるようにする。
        const b = this.meldBounds.get(slot.meldId);
        if (!b) {
          this.meldBounds.set(slot.meldId, { minX: p.x - halfW, maxX: p.x + halfW, minZ: p.z - halfW, maxZ: p.z + halfW });
        } else {
          b.minX = Math.min(b.minX, p.x - halfW);
          b.maxX = Math.max(b.maxX, p.x + halfW);
          b.minZ = Math.min(b.minZ, p.z - halfW);
          b.maxZ = Math.max(b.maxZ, p.z + halfW);
        }
      }
    }

    // 3) 捨て札（積み上げ表示へ復帰・契約14項目2）。R14 のグリッド面出しは卓を広く占有したため廃止し、
    //    従来どおり中央やや左のアンカーへコンパクトに積む。「何が/どの順で捨てられたか」は 3D の山を
    //    タップして出す履歴ポップアップ（app.ts）で読む。ジッタは id ハッシュで決定的（毎フレーム不動）。
    //    新規（最新）の 1 枚は捨てた席の手から飛ばす（項目5）。既存札の spawnPos は place で無視される。
    const discarder = view.claimWindow ? view.claimWindow.discarder : this.prevCurSeat;
    const discardSpawn = discarder >= 0 ? this.actorSpot(discarder) : deckPos;
    view.discardPile.forEach((card, k) => {
      const id = cardId(card);
      desired.add(id);
      const jx = (hashId(id) % 100) / 100 - 0.5;
      const jz = (((hashId(id) / 7) | 0) % 100) / 100 - 0.5;
      // 高さは枚数で伸ばすが上限を設け、山が卓上で暴走しない（E8）。新しい札ほど僅かに上＝最前面。
      const p = DISCARD_C.clone().add(
        new THREE.Vector3(jx * 0.14, TABLE_TOP_Y + 0.04 + Math.min(k, 26) * 0.012, jz * 0.14),
      );
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, jx * 0.6, 0, 'YXZ'));
      this.place(id, card, p, q, now, 0, discardSpawn);
    });

    // 既知カードのうち今回不要になったものを退場アニメ
    for (const [id, obj] of this.known) {
      if (!desired.has(id) && !obj.removing) {
        obj.removing = true;
        obj.removeAt = now;
      }
    }

    // 4) 他家手札（空中の浮遊扇）+ 5) 山札（実枚数連動スタック）。安定 ID 管理で退場はその場フェード、
    //    他家ツモは山札→手札の飛翔になる（項目3/4/6）。
    const dealing = this.freshDeal;
    this.freshDeal = false;
    this.syncBacks(view, now, dealing, deckPos);

    // ホットシートの手番交代でカメラを新しい操作者=視点席の既定視点へリセットする（契約14項目3）。
    // youIndex は「今このクライアントが操作している席」。ホットシートは手番ごとに変わり、通信対戦は
    // 自席固定で不変。前回と変わった＝ホットシートの手番交代とみなし、ユーザーがオービットしていても
    // 既定視点へ戻す（通信対戦では youIndex 不変のため決して発火せず、自席固定＝現状維持になる）。
    if (this.prevYouIndex >= 0 && this.prevYouIndex !== view.youIndex) {
      this.userControlled = false;
      this.pointers.clear();
      this.pinchDist = 0;
      this.tapCand = null;
    }
    this.prevYouIndex = view.youIndex;
    // カメラを現手番（=youIndex）席の背後へ演出移動。ただしユーザーが視点を操作中は勝手に戻さない
    // （契約07項目1: リセットはユーザー操作で。ラウンド切替=clearCards で自動的に既定へ復帰する）。
    if (!this.userControlled) this.aimCameraAt(view.youIndex);
    // 手番スポットは「現手番の席」を照らす（通信対戦では youIndex と別席になり得る）
    const curSeat = view.seats.find((s) => s.isCurrent)?.index ?? view.youIndex;
    this.setActiveSeat(curSeat);
    this.prevCurSeat = curSeat; // 次フレームの捨て札出所推定に使う（項目5）
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
    targetScale = 1,
  ): void {
    let obj = this.known.get(id);
    if (!obj) {
      const group = this.buildCard(card);
      group.position.copy(spawnPos);
      group.quaternion.copy(quat);
      group.scale.setScalar(targetScale * 0.55); // 出現ポップ（loop で targetScale へイージング）
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
        targetScale,
        meldId,
        spawnPos: spawnPos.clone(),
      };
      this.known.set(id, obj);
    } else {
      obj.targetPos.copy(pos);
      obj.targetQuat.copy(quat);
      obj.removing = false;
      obj.targetScale = targetScale; // メルド再配置でのスケール変化は loop が滑らかに追従（E3）
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
        // depthTest=false + 高い renderOrder で、卓上のカードや積み札に隠れず常に最前面へ描く
        // （項目2: ドラッグ開始時に全ドロップ先が確実に見える）。加算合成なので白飛びはしない。
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(geo, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = TABLE_TOP_Y + 0.06;
      m.renderOrder = 30;
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

  /** 手札 D&D の開始/終了を通知する。ドラッグ中はキャンバスのカメラ操作を無視する（項目10）。 */
  setHandDragging(active: boolean): void {
    this.handDragging = active;
    if (active) {
      // ドラッグ開始で進行中のオービット/ピンチ入力状態をクリアし、遷移ジャンプを防ぐ。
      this.pointers.clear();
      this.pinchDist = 0;
    }
  }

  /** ドラッグ開始時に全ドロップ先を同時に光らせる（E5: どこに落とすか一目で分かる）。 */
  showDropTargets(attachMeldIds: number[]): void {
    this.clearMeldRings();
    this.dropRings = [];
    this.attachableMelds = new Set(attachMeldIds); // dropTargetAt のメルド判定を付け札可能なものに限定（項目15b）
    this.discardRing.visible = true;
    this.dropRings.push({ mesh: this.discardRing, kind: 'discard', hot: false });
    // 場（公開）リングは現手番席のメルドゾーン（中央保護の床のすぐ外＝row0 付近）へ置く。
    const dir = this.seatDir(this.viewYou);
    this.fieldRing.position.copy(dir).multiplyScalar(centerKeepout(dir.x) + 0.6);
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
        // 付け札の光枠も、対象メルドのカードに隠れず最前面へ（項目2）。
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Mesh(this.meldRingGeo, mat);
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(c.x, TABLE_TOP_Y + 0.12, c.z);
      ring.renderOrder = 31;
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
    this.attachableMelds.clear();
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
        // 付け札できるメルドのヒットだけを標的にする。不可メルドは素通しして下の捨て札/場の判定へ
        // 落とす（誤付け札・誤トーストの解消・項目15b）。ドラッグ外（集合空）では従来どおり素通し。
        if (typeof mid === 'number' && this.attachableMelds.has(mid)) return { kind: 'meld', meldId: mid };
      }
    }
    // 2) 卓天板との交点から 捨て札 / 場 を判定（カメラ・リサイズに自動追従＝E3）
    const pt = this.raycaster.ray.intersectPlane(this.tablePlane, TMP_HIT);
    if (!pt) return null;
    if (Math.hypot(pt.x, pt.z) > TABLE_R) return null; // 卓外 = 取り消し（E6）
    // 2.5) ゾーンフォールバック（2026-08-11 ユーザー報告: ポンの666への付け札が「場」判定に化ける）:
    // カードメッシュへの厳密レイキャストは、縮小されたメルドカードやリング表示との僅かなズレで
    // 外れることがある。付け札可能メルドの外接矩形（+マージン）内に卓面交点が入っていれば
    // メルドとして拾う。光るリング＝ゾーンという視覚аффордансとも一致する。
    {
      const M = 0.18;
      let best: { mid: number; d: number } | null = null;
      for (const [mid, b] of this.meldBounds) {
        if (!this.attachableMelds.has(mid)) continue;
        if (pt.x >= b.minX - M && pt.x <= b.maxX + M && pt.z >= b.minZ - M && pt.z <= b.maxZ + M) {
          const d = Math.hypot(pt.x - (b.minX + b.maxX) / 2, pt.z - (b.minZ + b.maxZ) / 2);
          if (!best || d < best.d) best = { mid, d };
        }
      }
      if (best) return { kind: 'meld', meldId: best.mid };
    }
    if (Math.hypot(pt.x - DISCARD_C.x, pt.z - DISCARD_C.z) < DISCARD_R) return { kind: 'discard' };
    return { kind: 'field' };
  }

  /** 捨て札の山の履歴ポップアップを開くタップのハンドラを登録する（契約14項目2・app.ts が実装）。 */
  setDiscardTapHandler(cb: (() => void) | null): void {
    this.onDiscardTap = cb;
  }

  /** クライアント座標が卓上の捨て札の山（DISCARD_C ± DISCARD_R）を指すか。タップ判定に使う（項目2）。 */
  isDiscardPileAt(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const pt = this.raycaster.ray.intersectPlane(this.tablePlane, TMP_HIT);
    if (!pt) return false;
    return Math.hypot(pt.x - DISCARD_C.x, pt.z - DISCARD_C.z) < DISCARD_R;
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

  /**
   * 裏カード（他家手札＝空中扇 / 山札＝スタック）を安定 ID で同期する（項目3/4/6 再設計）。
   * - 既存キーは目標だけ更新（同一メッシュが滑らかに追従）。手番交代で席の可視が入れ替わっても
   *   卓を横断する誤アニメが出ない。
   * - 新規キーは生成。「他家がツモした末尾スロット」と配札のみ山札位置から飛ばし（fromDeck）、
   *   それ以外（席の可視トグル等）はその場に出現させる（E7: 誤飛翔の抑止）。
   * - 消えたキーは removing=true（loop がその場フェード）。山札方向へは動かさない（項目3: 吸い込み廃止）。
   */
  private syncBacks(view: PlayerView, now: number, dealing: boolean, deckPos: THREE.Vector3): void {
    const desired = new Map<string, { pos: THREE.Vector3; quat: THREE.Quaternion; fromDeck: boolean; delay: number }>();
    let dealIdx = 0;
    for (const seat of view.seats) {
      if (seat.index === view.youIndex) continue;
      const prev = this.backSeatCount.get(seat.index);
      const slots = this.floatHandLayout(seat.index, seat.handCount);
      slots.forEach((s, k) => {
        // 他家ツモ検出（項目3/E7）: 既に見えていた席が +1 枚で、その増えた末尾スロットだけを
        // 山札から飛翔させる。配札・席の可視トグル（ホットシートの youIndex 変化）では飛ばさない。
        const isDraw = prev !== undefined && seat.handCount === prev + 1 && k === seat.handCount - 1;
        desired.set(`h:${seat.index}:${k}`, {
          pos: s.pos,
          quat: s.quat,
          fromDeck: dealing || isDraw,
          delay: dealing ? dealIdx++ * DEAL_STEP_MS : 0,
        });
      });
      this.backSeatCount.set(seat.index, seat.handCount);
    }
    // 非表示になった席（人数減 / 自席化）の記録は破棄（次の +1 誤検出を防ぐ）。
    for (const idx of [...this.backSeatCount.keys()]) {
      if (!view.seats.some((s) => s.index === idx && idx !== view.youIndex)) this.backSeatCount.delete(idx);
    }
    // 山札: 高さ＝実枚数連動（項目4・E1）。0 枚でキーが無くなり山札は消える。
    const deckShown = Math.min(view.deckCount, 14);
    for (let i = 0; i < deckShown; i++) {
      desired.set(`d:${i}`, {
        pos: new THREE.Vector3(0.5, TABLE_TOP_Y + 0.03 + i * 0.02, 0),
        quat: DECK_QUAT,
        fromDeck: false,
        delay: dealing ? dealIdx++ * DEAL_STEP_MS : 0,
      });
    }

    for (const [key, t] of desired) {
      const obj = this.backById.get(key);
      if (!obj) {
        const group = this.buildCard(null);
        const spawn = t.fromDeck ? deckPos : t.pos;
        group.position.copy(spawn);
        group.quaternion.copy(t.quat);
        group.scale.setScalar(t.fromDeck ? 0.85 : 1);
        this.scene.add(group);
        this.backById.set(key, {
          id: key,
          group,
          born: now,
          delay: t.delay,
          targetPos: t.pos.clone(),
          targetQuat: t.quat.clone(),
          removing: false,
          removeAt: 0,
          spawned: t.delay === 0 && !t.fromDeck,
          targetScale: 1,
          spawnPos: spawn.clone(),
        });
      } else {
        obj.targetPos.copy(t.pos);
        obj.targetQuat.copy(t.quat);
        obj.removing = false;
      }
    }
    // 不要になったキーはその場フェード退場（山札方向へは動かさない）。
    for (const [, obj] of this.backById) {
      if (!desired.has(obj.id) && !obj.removing) {
        obj.removing = true;
        obj.removeAt = now;
      }
    }
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

  /**
   * カメラが回り込んで他家の空中手札（裏面）が視界を塞ぐ間、その手札を隠す（契約14項目4）。
   * 判定: 卓中心から見たカメラの水平方向 camDir と各席方向 seatDir の内積。内積が大きい席ほど
   * 「カメラと卓中心の間（＝手前）」にあり、その裏面手札が中央のやり取りを覆う。既定視点（自席の
   * 背後）では手前席＝自席（空中手札なし）なので他家は隠れない＝リセット直後に誤発火しない（E3）。
   * ヒステリシス（enter 0.62 / exit 0.46）でしきい値付近のちらつきを防ぐ。自席は元々空中手札なし。
   */
  private updateHandOcclusion(): void {
    const camDir = TMP_A.set(this.camera.position.x, 0, this.camera.position.z);
    if (camDir.lengthSq() < 1e-6) return;
    camDir.normalize();
    for (let seat = 0; seat < this.seatCount; seat++) {
      if (seat === this.viewYou) {
        this.blockedSeats.delete(seat);
        continue;
      }
      const dot = this.seatDir(seat).dot(camDir);
      const was = this.blockedSeats.has(seat);
      const now = was ? dot > 0.46 : dot > 0.62; // ヒステリシス
      if (now) this.blockedSeats.add(seat);
      else this.blockedSeats.delete(seat);
    }
    // 席ごとの可視状態を空中手札カード（キー h:<席>:<スロット>）へ反映。山札（d:）は対象外。
    for (const [key, obj] of this.backById) {
      if (key.charCodeAt(0) !== 104 /* 'h' */) continue;
      const seat = parseInt(key.slice(2), 10);
      obj.group.visible = !this.blockedSeats.has(seat);
    }
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
    this.camera.fov = this.orientationFov();
    this.camera.updateProjectionMatrix();
  }

  /** 画面の縦横に応じた画角（縦画面は視野が狭いので広角側）。aimCameraAt と resize で共有する（項目14）。 */
  private orientationFov(): number {
    return this.aspect() < 1 ? 58 : 46;
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
      // 手札を卓へドラッグ中はカメラ操作を無視する（別 pointerId のタッチでオービット/ピンチが
      // 誤発火して視点が飛ぶのを防ぐ・項目10）。手札 D&D は handEl 側がポインタを扱う。
      if (this.handDragging) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinchDist = this.currentPinchDist();
      // タップ候補を記録（単一ポインタのみ・契約14項目2/E2）。2本目が来たらピンチなのでタップ無効化。
      this.tapCand =
        this.pointers.size === 1
          ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false }
          : null;
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    this.onCamPointerMove = (e: PointerEvent): void => {
      if (this.handDragging) return;
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const nx = e.clientX;
      const ny = e.clientY;
      this.pointers.set(e.pointerId, { x: nx, y: ny });
      // タップ候補が閾値を超えて動いたらオービット/スワイプ扱い（タップ不成立・E2）。
      if (this.tapCand && this.tapCand.id === e.pointerId) {
        if (Math.hypot(nx - this.tapCand.x, ny - this.tapCand.y) > TAP_MOVE_MAX) this.tapCand.moved = true;
      }
      if (this.pointers.size >= 2) {
        // ピンチズーム（2本指）: 指間距離の比で半径を増減（E5・タッチ合成で検証）。
        this.tapCand = null;
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
      // タップ判定（契約14項目2）: 単一ポインタで移動閾値内・短時間・手札D&D中でなく、捨て札の山の上で
      // 離した場合のみ履歴ポップアップを開く（カメラスワイプ開始/ドロップと誤発火しない・E2）。
      const tc = this.tapCand;
      this.tapCand = null;
      if (
        tc &&
        tc.id === e.pointerId &&
        !tc.moved &&
        !this.handDragging &&
        performance.now() - tc.t < TAP_TIME_MAX &&
        this.isDiscardPileAt(e.clientX, e.clientY)
      ) {
        this.onDiscardTap?.();
      }
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
    // 検証用（契約14項目5）: 面カード（捨て札/メルド）のスポーン元＝飛翔の出発点を報告する。
    // 山札位置(0.5,*,0)から出れば「山札から沸く」旧挙動、自席前(低いy)/他家席前(高いy)なら操作者の
    // 手から出る新挙動。__cameraState/__dropProbe と同じく描画層内で完結する読み取り専用アクセサ。
    (el as unknown as { __spawnProbe?: (id: string) => unknown }).__spawnProbe = (id) => {
      const obj = this.known.get(id);
      if (!obj) return null;
      return {
        spawn: (obj.spawnPos.toArray() as number[]).map((n: number) => +n.toFixed(2)),
        target: (obj.targetPos.toArray() as number[]).map((n: number) => +n.toFixed(2)),
        current: (obj.group.position.toArray() as number[]).map((n: number) => +n.toFixed(2)),
        meldId: obj.meldId ?? null,
      };
    };
  }

  // ---- WebGL コンテキストロスト対応（項目11） --------------------------------
  // GPU ドライバのリセットやタブ資源回収でコンテキストが失われると、以後の描画は黒画面のまま
  // 放置される。lost は preventDefault で「復帰し得る」状態にし、日本語の再読み込み案内を出す。
  // restored ではループを再開し、案内を消す（テクスチャ等の再アップロードは three が担う）。
  private attachContextLossHandlers(): void {
    const el = this.renderer.domElement as HTMLCanvasElement;
    this.onContextLost = (e: Event): void => {
      e.preventDefault(); // 既定の「復帰しない」挙動を止め、restored を受け取れるようにする
      this.running = false;
      cancelAnimationFrame(this.raf);
      this.showLostNotice();
    };
    this.onContextRestored = (): void => {
      this.hideLostNotice();
      if (!this.running) {
        this.running = true;
        this.raf = requestAnimationFrame(this.loop);
      }
      this.wake();
    };
    el.addEventListener('webglcontextlost', this.onContextLost as EventListener);
    el.addEventListener('webglcontextrestored', this.onContextRestored as EventListener);
  }

  private showLostNotice(): void {
    if (this.lostNoticeEl) return;
    const box = document.createElement('div');
    box.className = 'gl-lost-notice';
    box.setAttribute('role', 'alert');
    box.style.cssText =
      'position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:12px;text-align:center;padding:24px;z-index:50;' +
      'background:rgba(6,10,16,0.86);color:#e8eef5;font-size:15px;line-height:1.6;';
    const msg = document.createElement('p');
    msg.textContent = '3D描画が中断しました（グラフィックが一時的に失われました）。復帰しない場合はページを再読み込みしてください。';
    msg.style.maxWidth = '28em';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '再読み込み';
    btn.style.cssText = 'padding:8px 18px;border-radius:8px;border:0;background:#2f8f6b;color:#fff;font-size:15px;cursor:pointer;';
    btn.onclick = (): void => globalThis.location?.reload();
    box.append(msg, btn);
    // container は relative 前提（renderer canvas を内包）。overlay として絶対配置する。
    if (getComputedStyle(this.container).position === 'static') this.container.style.position = 'relative';
    this.container.appendChild(box);
    this.lostNoticeEl = box;
  }

  private hideLostNotice(): void {
    this.lostNoticeEl?.remove();
    this.lostNoticeEl = null;
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
    // カメラが手前に回り込んだ他家の空中手札を隠す（契約14項目4）。カメラのイージングに毎フレーム追従。
    this.updateHandOcclusion();

    // 既知カード補間 + 出現ポップ + 退場処理
    for (const [id, obj] of this.known) {
      if (now - obj.born >= obj.delay) {
        obj.spawned = true;
        motion += obj.group.position.distanceTo(obj.targetPos);
        obj.group.position.lerp(obj.targetPos, k);
        obj.group.quaternion.slerp(obj.targetQuat, k);
        if (!obj.removing) {
          const ts = obj.targetScale;
          const s = obj.group.scale.x;
          if (Math.abs(s - ts) > 0.001) {
            obj.group.scale.setScalar(s + (ts - s) * k);
            motion += Math.abs(ts - s);
          }
        }
      } else {
        busy = true; // 配札ディレイ待ち
      }
      if (obj.removing) {
        busy = true;
        // 退場フェードは目標スケール基準（縮小メルドが退場時に一瞬拡大しない）
        const s = obj.targetScale * Math.max(0, 1 - (now - obj.removeAt) / 260);
        obj.group.scale.setScalar(s);
        if (s <= 0.001) {
          this.scene.remove(obj.group);
          this.known.delete(id);
        }
      }
    }
    // 裏カード補間（安定 ID・配札/ツモ飛翔の delay 尊重・退場はその場フェード）
    for (const [id, obj] of this.backById) {
      if (now - obj.born < obj.delay) {
        busy = true;
        continue;
      }
      motion += obj.group.position.distanceTo(obj.targetPos);
      obj.group.position.lerp(obj.targetPos, k);
      obj.group.quaternion.slerp(obj.targetQuat, k);
      if (!obj.removing) {
        // 出現ポップ（飛翔カードは 0.85→1.0 に膨らむ）
        const s = obj.group.scale.x;
        if (Math.abs(s - 1) > 0.001) {
          obj.group.scale.setScalar(s + (1 - s) * k);
          motion += Math.abs(1 - s);
        }
      } else {
        busy = true;
        const s = Math.max(0, 1 - (now - obj.removeAt) / 260);
        obj.group.scale.setScalar(s);
        if (s <= 0.001) {
          this.scene.remove(obj.group);
          this.backById.delete(id);
        }
      }
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
    // 縦横切替（回転）に追従して画角を更新する。userControlled 中でも適用し、縦画面で卓が
    // 見切れる/横画面で寄りすぎるのを防ぐ（項目14）。オービットの位置・注視点は保持する。
    this.camera.fov = this.orientationFov();
    this.camera.updateProjectionMatrix();
    this.postfx?.setSize(w, h, this.renderer.getPixelRatio());
    this.particles.setScale(this.particleScale());
    this.wake();
  }

  /** ラウンド切り替え等でカードを全消去（次の update で再構築＝配札スタッガ演出）。 */
  clearCards(): void {
    for (const [, obj] of this.known) this.scene.remove(obj.group);
    this.known.clear();
    for (const [, obj] of this.backById) this.scene.remove(obj.group);
    this.backById.clear();
    this.backSeatCount.clear();
    this.freshDeal = true;
    // 新ラウンドは既定視点から始める（項目1: ラウンド開始の自動カメラ演出を維持）。
    this.userControlled = false;
    this.pointers.clear();
    this.pinchDist = 0;
    // 手番交代リセット/捨て札出所/遮蔽判定の状態も破棄（前ラウンドの席で誤発火しないように）。
    this.prevYouIndex = -1;
    this.prevCurSeat = -1;
    this.blockedSeats.clear();
    this.tapCand = null;
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
    cel.removeEventListener('webglcontextlost', this.onContextLost as EventListener);
    cel.removeEventListener('webglcontextrestored', this.onContextRestored as EventListener);
    this.hideLostNotice();
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
    this.backById.clear();
    this.backSeatCount.clear();

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
