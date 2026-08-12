// Three.js 3D 卓シーン。すべてプロシージャル（外部アセットなし・要件 D7 / §3.2）。
// アニメーションは「各カードを目標トランスフォームへ毎フレーム補間」する統一モデル。
// これにより 配札/ツモ/捨て札/メルド公開/付け札/ポン・チー が同一機構で滑らかに表現され、
// 即時テレポートを避ける（要件§3.2）。ジオメトリ/マテリアルは共有し draw call を抑制（E5）。
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Card, Meld, PlayerView } from '../core';
import { cardId } from '../core';
import { backTexture, disposeCardTextures, faceTexture, setMaxAnisotropy } from './cardTexture';
import { disposeFelt, feltTexture } from './felt';
import { buildPlushDolls, disposePlushTextures } from './plush';
import { PlushReactions } from './plushReaction';
import { HIDE_SPOTS, hashSeed, type HideSpot } from './hideSpots';
import { makeFloorWood, makeWallPaper, makeCeilingWood, makeRugPattern, makeRectRug, makeShadowBlob } from './roomTextures';
import { FURNITURE_BOXES } from './hideSpots';
import { nextRng, shuffle } from '../core';
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
export const DEAL_STEP_MS = 42; // 配札スタッガ（1枚ごとの遅延・app.ts の配札SFX同期で共有・Q9）
const ENTRANCE_MS = 340; // 出現アニメ時間（easeOutBack のバネ・オーバーシュート・Q6/Q12）
// タイトル背景のシネマデモの負荷制限（契約19項目3: 発熱/負荷対策）。常時60fpsでの全品質描画が主要な発熱源。
// 背景（UIの後ろ）なので~32fps・低DPRでも体感差はほぼ無く、GPU/CPU負荷を大きく下げられる。
const CINE_FRAME_MIN = 1 / 32; // シネマ時の最小フレーム間隔（秒）＝約32fpsに間引く
const CINE_DPR_CAP = 1.0; // シネマ時のDPR上限（背景なので等倍で十分）
const SWEEP_MS = 420; // ラウンド遷移の旧札掃引退場の時間（Q1）
const MAX_RINGS = 10; // 光輪（ショックウェーブ）の同時上限（派手化で二重リングを出すため増量・契約09項目2）
const DISCARD_C = new THREE.Vector3(-0.5, TABLE_TOP_Y, 0); // 捨て札の山の中心（update と一致）
// 山札カードの向き（卓に伏せて水平・面下）。毎フレームの Euler 生成を避け共有する。
const DECK_QUAT = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const DISCARD_R = 0.62; // 捨て札ドロップ判定の半径（山札 +0.5 と干渉しない大きさ）
const TABLE_R = 3.5; // 卓天板の半径（この外へのドロップは卓外＝取り消し）
// 静的背景（家具・調度）の1メッシュ統合（契約20項目4）。初期化時にマテリアル毎（不透明/発光）へ
// ジオメトリを事前統合し描画コールを最小化する。false にすると各プリミティブを個別メッシュで置く
// ＝統合前の描画コール数を計測できる（before/after 比較用・恒久的な設計スイッチ）。
const MERGE_FURNITURE = true;

// ユーザーカメラ操作（契約17項目7）: 自席固定の首振り（見渡し）。視点位置は自席の目線に固定し、
// ドラッグ/スワイプでヨー・ピッチ（見回し）、ピンチ/ホイールでズーム（FOV）を操作する。
// オービット（卓中心を軸に回り込む）は廃止した。回り込みが物理的に無くなるため他家手札の遮蔽
// フェード（updateHandOcclusion）は不要化した（E5）。
// 既定視点（契約18項目2）: R17以前の「卓全体が見える俯瞰寄りの構図」へ戻す。首振り化で目線が
// 下がり卓が見づらくなったため、目線を旧カメラ位置相当（水平距離~6.25・高さ~4.3・注視=卓中央で
// 俯角~34°、旧 camPos(0,4,6) と同等）まで引き上げ、そこを基点に首振りする。
const EYE_BACK = 3.7; // 自席（SEAT_R=2.55）からさらに外側へ引いた目線の水平位置（合計~6.25＝旧z相当）
const EYE_HEIGHT = 4.3; // 目線の高さ（卓面 y=0 の上・旧カメラ高さ相当。卓全体を俯瞰できる）
const MIN_PITCH = -1.3; // 見下ろし限界（卓面直下まで・カードが裏返らない約 -74°）
const MAX_PITCH = 0.66; // 見上げ限界（天井まで・真上で反転しない約 +38°）
const MIN_FOV = 32; // ズームイン限界（望遠寄り）
const MAX_FOV = 74; // ズームアウト限界（広角寄り・真後ろの壁も破綻せず入る）
const LOOK_YAW_SENS = 0.0044; // ヨー感度（rad/px）
const LOOK_PITCH_SENS = 0.0044; // ピッチ感度（rad/px）
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
  // カードごとに複製した材質（共有材質のクローン）。opacity を個別に動かすため（Q5/Q6/U3）。
  // 共有マップ（face/back テクスチャ）はクローンでも参照共有されるため、重い資源は増えない。
  // 一貫して transparent=true・depthWrite=true とし、定常時は opacity=1 で不透明カードと同じ描画になる
  // （メルド段差の Z 整合＝distinctY を壊さない・E7）。
  mats: THREE.Material[];
  opacity: number; // 現在の可視不透明度（出現=0→1 フェードイン / 退場・遮蔽=→0 フェードアウト）
  occluded: boolean; // カメラ回り込みで手前を塞ぐ他家手札（U3: フェードで消す対象）
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
  // （契約22項目1で撤去）デモ手札の両面表は廃止。外側＝裏面デザインの通常カードに戻したため、
  //   反転表絵柄の材質キャッシュ（demoBackMatCache）は不要になった。
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
  // タイトル背景デモ専用の手札公開（契約20項目2）。席index→実手札。設定時は syncBacks が裏向き浮遊札の
  // 代わりに全席の実絵柄を表向きで浮かべる（表示層のみ・実対局の視界フィルタ deriveViewFor には無関係）。
  private demoHands: Map<number, Card[]> | null = null;

  // カメラ演出
  private camPos = new THREE.Vector3(0, 4, 6);
  private camTarget = new THREE.Vector3(0, 0, 0);
  private camPosGoal = new THREE.Vector3(0, 4, 6);
  private camTargetGoal = new THREE.Vector3(0, 0, 0);

  // ユーザーカメラ操作の状態（契約17項目7）。userControlled 中は自動フレーミング（aimCameraAt）を
  // 抑止し、ユーザーが選んだ首振り角/ズームを保持する。リセットボタン / ラウンド切替（clearCards）で解除。
  // 視点位置は自席固定なので camPosGoal（=目線）はユーザー操作では動かさず、lookYaw/lookPitch だけを動かす。
  private userControlled = false;
  private lookYaw = 0; // 見回しのヨー（水平角・rad）
  private lookPitch = -0.42; // 見回しのピッチ（俯仰角・rad。負=見下ろし）
  private lookFov = 46; // 現在のズーム（画角）
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
  private camShakeScale = 1; // 現行パンチのシェイク倍率（他家起因は明確に弱める・契約19項目2）
  private freshDeal = false; // clearCards 直後の一括配札（スタッガ演出）
  private ringGeo!: THREE.RingGeometry;
  private rings: { mesh: THREE.Mesh; t: number; dur: number; r0: number; r1: number; op: number }[] = [];
  // ラウンド遷移の旧札掃引退場（Q1）。clearCards が現行カードをここへ移し、loop がフェード+掃引で消す。
  private sweeping: { group: THREE.Group; mats: THREE.Material[]; born: number; to: THREE.Vector3 }[] = [];
  // タイトル背景のデモ対局用シネマティックカメラ（U4/契約19項目5）。true の間は複数のカメラカット
  // （ドリーイン/アウト・ロー/ハイアングル・卓面すれすれのトラッキング等）を黒フェードで切り替えて
  // ループする。idle しない。
  private cinematic = false;
  private cineShotIdx = 0;
  private cineShotT = 0; // 現在カットの経過秒
  private cineBaseYaw = 0; // カットごとにずらす基準方位
  private cineFadeEl: HTMLElement | null = null; // カット境界の黒フェード（デモ卓の上・タイトルUIの下）
  private cineFrameAccum = 0; // シネマ間引き用の経過時間アキュムレータ（契約19項目3）
  // ドロップ光枠のフェードアウト（Q15）。hideDropTargets は即消しでなくここでフェードしてから片付ける。
  private dropHiding = false;
  private dropHideAt = 0;
  // 手番表示（契約17項目2 再設計）: 現手番席の卓上に淡い金色の光だまり + 細い金環を出し「誰の番か」を
  // 席方向で明示する（席名ラベルの金強調と連動）。自席の手番では控えめ（ほぼ非表示）にして、旧実装の
  // 「自分の前に出る謎の白い円」感を解消する。spotTarget（現手番席の前）に追従して脈動する。
  private spotGlow!: THREE.Mesh;
  private spotRing!: THREE.Mesh; // 光だまりを縁取る細い金環（手番マーカーだと分かる輪郭）
  private activeSeatSelf = false; // 現手番が自席か（自席では光だまりを控えめにする）
  private spotGlowOp = 0; // 光だまりの現在不透明度（表示/非表示をフェード）
  // 鳴きウィンドウ開始演出（Q11）: 対象の捨て札上で脈動する3Dハイライトリング。
  private claimRing!: THREE.Mesh;
  private claimFocusActive = false;

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
  // Meshy生成のぬいぐるみGLB（読み込めた場合のみ・dispose対象。契約24）
  private plushGlbs: THREE.Object3D[] = [];
  // 契約25(R27): Meshy 家具ロード成功時に除去するプロシージャル家具メッシュ / 統合家具GLB
  private swapFurniture: THREE.Mesh[] = [];
  private roomGlb: THREE.Object3D | null = null;
  // 契約26(R28): かくれんぼ。plushSrc はロード済み GLB（クローン元）。hideSeed は
  // 「ルームコード#ラウンド」等の共有シード（app が setHideSeed で注入・全クライアント同一）。
  private plushSrc: { panda?: THREE.Object3D; dalmatian?: THREE.Object3D } = {};
  private hideSeed: string | null = null;
  private hiddenPlush: THREE.Object3D[] = [];
  // 契約27(R29): 躯体/ラグの Canvas テクスチャとラグメッシュ（dispose 対象）
  private roomTextures: THREE.Texture[] = [];
  private rugMesh: THREE.Mesh | null = null;
  // 契約32(R35): ゾーンラグ+接地影メッシュ（dispose対象）と「見えている床」円盤
  private zoneDecor: THREE.Mesh[] = [];
  private floorDisc: THREE.Mesh | null = null;
  /** かくれんぼ発見通知（初回注視リアクション時に一度だけ・app がコールアウト/SFXへ接続）。 */
  onHiddenFound: ((kind: 'dalmatian' | 'panda') => void) | null = null;
  // 検証用（契約29追補）: __spotShot が置くテスト個体（常に1体・呼ぶたび置き直す）
  private testPlush: THREE.Object3D | null = null;
  // ぬいぐるみ「見つめると反応する」リアクション（契約24）。注視+ズーム検知→両体の transform 演出。
  private plushReactions: PlushReactions | null = null;
  // リアクションの効果音トリガ（app.ts が AudioKit へ接続する・src/render は音を持たない）。
  onPlushReaction: ((kind: 'wave' | 'bounce') => void) | null = null;
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
      basePos: THREE.Vector3; // 席のワールド基準位置（クランプ撤去・契約18項目3。視界外は自然に見切れる）
      opacity: number; // 現在の可視不透明度（Q8: 表示切替・手番強調をクロスフェード）
      opacityTarget: number; // 目標（表示=1 / 非表示=0）
      behind: boolean; // カメラ背面にある（背面投影で正面へ化けるため強制非表示・契約18項目3）
      current: boolean; // 現手番席か（手番色ワイプの向きを決める・契約21項目7）
      phase: number; // 手番色ワイプの現在進捗 0..1（0=非手番・1=手番の金）。テクスチャ描画に渡す
      phaseTarget: number; // ワイプの目標（手番獲得=1 / 手番喪失=0）。高速交代で即差し替え（E3）
      name: string; // 直近描画に使った名前（ワイプ再描画で必要）
      score: number; // 直近描画に使った累計失点
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

    // 卓下の影の受け皿（部屋の床の上に敷く円盤）。
    // 契約32: この円盤（y=-0.45・半径14）が部屋全体の床を覆っており「見えている床」の実体はこれ。
    // 従来はほぼ黒の単色＝のっぺりの真因だった。マテリアルは buildRoom が木目テクスチャ一式で差し替える。
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(14, 48),
      new THREE.MeshStandardMaterial({ color: '#5a4530', roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.45;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.floorDisc = floor;
  }

  /**
   * 家の部屋風の囲い（項目7）: 内向き（BackSide）の箱で床・壁・天井を作り、暖色の環境に見せる。
   * 全メッシュは既定レイヤ(0)のまま＝選択的 Bloom（レイヤ1のみ黒背景抽出）には一切載らない（E3）。
   * カード視認性を損なわないよう壁は暗めの暖色。モバイル（low ティア）では窓/据置ライトを省き軽量化。
   */
  private buildRoom(): void {
    const S = 18; // 部屋の一辺（首振り[項目7]でどの方向を見ても家具が入る距離まで壁を寄せる・項目6）
    const H = 6.6; // 天井高（一回り低くして居間の密度を上げる・項目6）
    const floorY = -0.5;
    const wallZ = S / 2; // 壁の内面座標
    // BoxGeometry の面順: +x, -x, +y(天井), -y(床), +z, -z。面ごとに材質を割り当てる。
    // 契約27(R29): 躯体を単色→プロシージャルテクスチャへ（木目フローリング・壁紙+腰壁・板張り天井）。
    // 従来と同じ暖色パレットで描いているため照明・フォグ・カード視認性は据え置き。
    const floorTexs = makeFloorWood(); // カラー+法線+粗さの3点セット（契約29: のっぺり解消）
    const wallTex = makeWallPaper();
    const ceilTex = makeCeilingWood();
    this.roomTextures.push(floorTexs.map, floorTexs.normalMap, floorTexs.roughnessMap, wallTex, ceilTex);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.96, metalness: 0, side: THREE.BackSide });
    const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, roughness: 0.97, metalness: 0, side: THREE.BackSide });
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTexs.map,
      normalMap: floorTexs.normalMap,
      roughnessMap: floorTexs.roughnessMap,
      roughness: 1, // roughnessMap の値をそのまま使う（乗算係数）
      metalness: 0,
      envMapIntensity: 1.3, // 契約31: 磨いた床の環境映り込みで艶と情報量を出す
      // 契約32: 照明の届かない領域で床が真っ黒＝のっぺりの真因。テクスチャ自体を弱く自己発光させ、
      // どの席・どの方角からでも板目が読める下限輝度を保証する（カード視認性には無関係）。
      emissiveMap: floorTexs.map,
      emissive: new THREE.Color('#4d4d4d'),
      side: THREE.BackSide,
    });
    floorMat.normalScale?.set?.(1.3, 1.3);
    // 「見えている床」＝影受け円盤（半径14・y=-0.45）へ同じ木目一式を適用（契約32・のっぺりの真因対策）。
    // 円盤は直径28mにUV1枚なので、板スケールを箱面（18mにrepeat5）と揃えるため repeat 7.8 のクローンを使う。
    if (this.floorDisc) {
      const cloneTex = (t: THREE.Texture): THREE.Texture => {
        const c = t.clone();
        c.repeat.set(7.8, 7.8);
        c.needsUpdate = true;
        this.roomTextures.push(c);
        return c;
      };
      const dMap = cloneTex(floorTexs.map);
      (this.floorDisc.material as THREE.Material).dispose?.();
      const discMat = new THREE.MeshStandardMaterial({
        map: dMap,
        normalMap: cloneTex(floorTexs.normalMap),
        roughnessMap: cloneTex(floorTexs.roughnessMap),
        roughness: 1,
        metalness: 0,
        envMapIntensity: 1.3,
        emissiveMap: dMap,
        emissive: new THREE.Color('#4d4d4d'),
      });
      discMat.normalScale?.set?.(1.3, 1.3);
      this.floorDisc.material = discMat;
    }
    const mats = [wallMat, wallMat, ceilMat, floorMat, wallMat, wallMat];
    const room = new THREE.Mesh(new THREE.BoxGeometry(S, H, S), mats);
    room.position.set(0, floorY + H / 2, 0);
    room.receiveShadow = false; // 内壁は影計算に含めない（コスト削減・見た目に不要）
    this.scene.add(room);
    // 部屋を寄せたのでフォグ遠方を壁の手前に合わせ直す（壁が奥へ自然に溶ける）。
    this.scene.fog = new THREE.Fog('#40301f', 10, 22);
    this.buildFurniture(floorY, wallZ, H);
  }

  /**
   * フルセットの居間の内装（U1）: 窓+カーテン・本棚・ソファ+サイドテーブル+ランプ・ラグ・観葉植物・
   * 壁の額・天井照明。すべてプロシージャル（低頂点の Box/Cylinder を共有ジオメトリで大量配置）で、
   * ティアに依らず同一のフルセットを作る（モバイルも省略しない）。全メッシュは既定レイヤ(0)のまま＝
   * 選択的 Bloom（レイヤ1抽出）には一切載らない（E1）。装飾は影計算に含めず（cast/receive=false）、
   * 部屋の影・フォグ・60fps 目標に干渉しない。点光源はティアで加減し、明るさは発光メッシュで底上げする。
   */
  private buildFurniture(floorY: number, wallZ: number, H: number): void {
    // 契約20項目4: 静的背景ジオメトリの1メッシュ統合。すべての家具プリミティブを「不透明(標準)」と
    // 「発光(basic)」の2バケットへ頂点カラー付きで積み、初期化時に mergeGeometries でマテリアル毎に
    // 1メッシュへ統合する（頂点カラーでマテリアル数を2まで圧縮＝描画コール最小化）。動く光/針は無いため
    // 全家具が静的＝安全に統合できる。統合後の1メッシュは部屋全体を包む境界球になりフラスタムカリング
    // されないが、描画コール削減が主目的のため許容（契約20 E4）。影/フォグ/Bloom は据え置き:
    // 全家具は cast/receive=false・既定レイヤ(0)のまま＝選択的 Bloom（レイヤ1抽出）に一切載らない。
    const opaque: THREE.BufferGeometry[] = []; // MeshStandardMaterial(vertexColors) 行き
    const glow: THREE.BufferGeometry[] = []; // MeshBasicMaterial(vertexColors) 行き＝発光面
    // 契約25(R27): Meshy 家具 GLB（room-furniture.glb）が読み込めたら差し替えるプリミティブは
    // swap バケットへ分けて焼き、ロード成功時にシーンから除去する。失敗時はそのまま残る
    // （プロシージャル版フォールバック・ぬいぐるみ GLB と同方式）。
    const swapOpaque: THREE.BufferGeometry[] = [];
    const swapGlow: THREE.BufferGeometry[] = [];
    let swap = false; // true の間に bake されたものは swap バケット行き
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitCyl = new THREE.CylinderGeometry(0.5, 0.5, 1, 14);
    const unitPlane = new THREE.PlaneGeometry(1, 1);
    const P = new THREE.Vector3();
    const S = new THREE.Vector3();
    const Q = new THREE.Quaternion();
    const E = new THREE.Euler();
    const M = new THREE.Matrix4();
    const tmpCol = new THREE.Color();
    // 1プリミティブ = 「単位ジオメトリを w/h/d 拡縮 + 回転 + 平行移動して焼き込み、頂点カラーを塗って
    // バケットへ積む」。頂点カラーは sRGB→リニア変換して従来の material.color と同じ見た目にする。
    const bake = (
      bucket: THREE.BufferGeometry[], geom: THREE.BufferGeometry, color: string,
      w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0,
    ): void => {
      E.set(rx, ry, rz, 'YXZ');
      Q.setFromEuler(E);
      M.compose(P.set(x, y, z), Q, S.set(w, h, d));
      geom.applyMatrix4(M);
      tmpCol.set(color).convertSRGBToLinear();
      const n = geom.attributes.position.count;
      const ca = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        ca[i * 3] = tmpCol.r;
        ca[i * 3 + 1] = tmpCol.g;
        ca[i * 3 + 2] = tmpCol.b;
      }
      geom.setAttribute('color', new THREE.Float32BufferAttribute(ca, 3));
      // swap モード中は呼び出し側の指定（opaque/glow）を対応する swap バケットへ振り替える（契約25）。
      (swap ? (bucket === glow ? swapGlow : swapOpaque) : bucket).push(geom);
    };
    const boxP = (color: string, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): void =>
      bake(opaque, unitBox.clone(), color, w, h, d, x, y, z, 0, ry, 0);
    const cylP = (color: string, r: number, h: number, x: number, y: number, z: number): void =>
      bake(opaque, unitCyl.clone(), color, r * 2, h, r * 2, x, y, z);
    const woodDark = '#3f2c1a';
    const woodMid = '#6b4a2c';

    // ラグ（契約27）: オリエンタル風パターンのテクスチャ円盤（従来の単色円盤+2リングを置換・+1描画コール）。
    const rugTex = makeRugPattern();
    this.roomTextures.push(rugTex);
    this.rugMesh = new THREE.Mesh(
      new THREE.CircleGeometry(5.2, 48),
      new THREE.MeshStandardMaterial({ map: rugTex, roughness: 0.95, metalness: 0, emissiveMap: rugTex, emissive: new THREE.Color('#474747') }),
    );
    this.rugMesh.rotation.x = -Math.PI / 2;
    this.rugMesh.position.y = floorY + 0.072; // 見えている床（影受け円盤 y=-0.45）の上（契約32）
    this.rugMesh.receiveShadow = false;
    this.scene.add(this.rugMesh);

    // 契約32(R35): 床の奥行き — ゾーンラグ2枚 + 全床置き家具の接地影（フェイクAO・+3描画コール）。
    const rectRugTex = makeRectRug();
    this.roomTextures.push(rectRugTex);
    const rectRug = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 4.8),
      new THREE.MeshStandardMaterial({ map: rectRugTex, roughness: 0.97, metalness: 0, emissiveMap: rectRugTex, emissive: new THREE.Color('#474747') }),
    );
    rectRug.geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    rectRug.rotation.y = 0.06;
    rectRug.position.set(-6.7, floorY + 0.069, 1.9); // ソファゾーン（コーヒーテーブル/プフが上に載る）
    this.scene.add(rectRug);
    this.zoneDecor.push(rectRug);
    const nookRugTex = makeRugPattern();
    this.roomTextures.push(nookRugTex);
    const nookRug = new THREE.Mesh(
      new THREE.CircleGeometry(1.9, 40),
      new THREE.MeshStandardMaterial({ map: nookRugTex, roughness: 0.97, metalness: 0, emissiveMap: nookRugTex, emissive: new THREE.Color('#474747') }),
    );
    nookRug.geometry.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    nookRug.position.set(6.6, floorY + 0.067, -6.1); // 読書ヌック（アームチェアの下）
    this.scene.add(nookRug);
    this.zoneDecor.push(nookRug);
    // 接地影: 家具AABBの実測値から楕円ブロブを1メッシュに統合（家具が床に「置いてある」感を出す）
    const blobTex = makeShadowBlob();
    this.roomTextures.push(blobTex);
    const blobGeos: THREE.BufferGeometry[] = [];
    const M2 = new THREE.Matrix4();
    for (const b of FURNITURE_BOXES) {
      if (b.name === 'table' || b.min[1] > -0.45) continue; // 床置き家具のみ（吊り・壁掛けは除外）
      const cx = (b.min[0] + b.max[0]) / 2;
      const cz = (b.min[2] + b.max[2]) / 2;
      // ラグの上に載る家具はラグ自体が接地感を出すので影を省く（重なって黒沈みするのを防ぐ）
      if (cx > -8.4 && cx < -5.0 && cz > -0.5 && cz < 4.3) continue; // ソファゾーンのラグ
      if (Math.hypot(cx - 6.6, cz + 6.1) < 1.9) continue; // 読書ヌックの丸ラグ
      const g2 = new THREE.PlaneGeometry((b.max[0] - b.min[0]) * 0.95, (b.max[2] - b.min[2]) * 0.95);
      g2.applyMatrix4(M2.makeRotationX(-Math.PI / 2));
      g2.applyMatrix4(M2.makeTranslation(cx, floorY + 0.063, cz));
      blobGeos.push(g2);
    }
    const blobs = new THREE.Mesh(
      mergeGeometries(blobGeos, false),
      new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }),
    );
    blobs.receiveShadow = false;
    this.scene.add(blobs);
    this.zoneDecor.push(blobs);

    // 窓（-z 壁）+ 十字桟 + 左右カーテン。発光パネルは glow バケット（Bloom 非対象・レイヤ0）。
    const winW = 5.0;
    const winH = 3.2;
    const winY = floorY + 3.4;
    const winZ = -wallZ + 0.06;
    bake(glow, unitPlane.clone(), '#ffd7a0', winW, winH, 1, -3, winY, winZ);
    bake(glow, unitBox.clone(), '#241708', 0.14, winH + 0.3, 0.06, -3, winY, winZ + 0.02); // 縦桟
    bake(glow, unitBox.clone(), '#241708', winW + 0.3, 0.14, 0.06, -3, winY, winZ + 0.02); // 横桟
    boxP(woodDark, winW + 0.6, 0.28, 0.24, -3, winY + winH / 2 + 0.2, winZ + 0.02); // 窓上枠
    const curtain = '#8a3f38';
    for (const sx of [-1, 1]) {
      boxP(curtain, 1.0, winH + 0.8, 0.14, -3 + sx * (winW / 2 + 0.3), winY, winZ + 0.12);
      // カーテンのひだ（縦の細板・密度向上）
      for (let f = 0; f < 3; f++)
        boxP('#742f2c', 0.16, winH + 0.8, 0.05, -3 + sx * (winW / 2 + 0.1 + f * 0.22), winY, winZ + 0.2);
    }

    swap = true; // ---- ここから Meshy 家具（本棚/ソファ/サイドテーブル/植物）で差し替わる区間（契約25） ----
    // 本棚（+x 壁ぎわ）: 枠 + 棚板を増やし（6段）背表紙をぎっしり（各段12冊）。上に小物も置く。
    const shelfX = wallZ - 0.5;
    const shelfY = floorY + 2.2;
    boxP(woodMid, 0.42, 4.4, 2.9, shelfX, shelfY, -3); // 側板・背
    const bookColors = ['#b5462f', '#3f6ea5', '#c9a23a', '#4d7a4a', '#7a4a86', '#c26b3a', '#2f6e6a', '#a84a6f'];
    for (let s = 0; s < 6; s++) {
      const sy = floorY + 0.5 + s * 0.72;
      boxP(woodDark, 0.38, 0.07, 2.7, shelfX - 0.06, sy - 0.16, -3); // 棚板
      for (let b = 0; b < 12; b++) {
        const bc = bookColors[(s * 5 + b) % bookColors.length]!;
        const bh = 0.42 + ((b * 7 + s * 3) % 5) * 0.045;
        const lean = b % 7 === 6 ? 0.18 : 0; // ときどき傾いた本
        bake(opaque, unitBox.clone(), bc, 0.24, bh, 0.14, shelfX - 0.06, sy + bh / 2 - 0.12, -3 - 1.28 + b * 0.235, 0, 0, lean);
      }
    }
    // 本棚上の飾り（花瓶・小箱）
    cylP('#7a9bb0', 0.16, 0.5, shelfX - 0.06, shelfY + 2.35, -3.6);
    boxP('#c9a23a', 0.4, 0.3, 0.3, shelfX - 0.06, shelfY + 2.3, -2.4);

    // ソファ（-x 壁ぎわ・卓へ向く）: 座面 + 背 + 肘掛け + クッション4つ + 足クッション。
    const sofaX = -wallZ + 1.0;
    const sofaBase = '#3f5b6e';
    boxP(sofaBase, 1.5, 0.7, 4.2, sofaX, floorY + 0.35, 2); // 座面
    boxP(sofaBase, 0.6, 1.5, 4.2, sofaX - 0.55, floorY + 0.9, 2); // 背
    boxP(sofaBase, 1.6, 1.0, 0.5, sofaX, floorY + 0.7, 2 - 2.1); // 肘掛け
    boxP(sofaBase, 1.6, 1.0, 0.5, sofaX, floorY + 0.7, 2 + 2.1);
    const cushCol = ['#c9a23a', '#b5462f', '#4d7a4a', '#7a4a86'];
    for (let c = 0; c < 4; c++)
      boxP(cushCol[c]!, 0.85, 0.5, 0.85, sofaX + 0.2, floorY + 0.85, 0.7 + c * 0.85, (c % 2 ? 0.2 : -0.2));
    boxP('#2f6e6a', 1.1, 0.4, 1.1, sofaX + 1.3, floorY + 0.2, 2); // 足置きクッション

    // サイドテーブル + ランプ（ソファ脇）: 天板 + 脚 + ランプ台 + 発光シェード + 卓上の本/マグ。
    const stX = -wallZ + 1.2;
    const stZ = -1.6;
    cylP(woodMid, 0.55, 0.12, stX, floorY + 1.0, stZ); // 天板
    boxP(woodDark, 0.14, 1.0, 0.14, stX, floorY + 0.5, stZ); // 脚
    cylP('#20242b', 0.08, 0.5, stX, floorY + 1.3, stZ); // ランプ支柱
    bake(glow, new THREE.ConeGeometry(0.42, 0.5, 18, 1, true), '#ffdca0', 1, 1, 1, stX, floorY + 1.75, stZ); // シェード
    boxP('#b5462f', 0.34, 0.12, 0.24, stX + 0.2, floorY + 1.12, stZ + 0.15); // 卓上の本
    cylP('#d8d2c4', 0.09, 0.14, stX - 0.18, floorY + 1.13, stZ - 0.1); // マグ

    // 観葉植物（隅 3 か所）: 鉢 + 葉（低ポリの円錐を数枚）。
    const plant = (px: number, pz: number): void => {
      cylP('#7a4a2c', 0.45, 0.7, px, floorY + 0.35, pz); // 鉢
      cylP('#4a3524', 0.4, 0.12, px, floorY + 0.72, pz); // 土
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        bake(opaque, new THREE.ConeGeometry(0.34, 1.7, 8), '#3f6b3a',
          1, 1, 1, px + Math.cos(a) * 0.18, floorY + 1.5, pz + Math.sin(a) * 0.18, Math.sin(a) * 0.3, 0, Math.cos(a) * 0.3);
      }
    };
    plant(wallZ - 1.2, wallZ - 1.2);
    plant(-wallZ + 1.2, wallZ - 1.2);
    plant(-wallZ + 1.2, -wallZ + 3.0);

    swap = false; // ---- 額/天井照明/梁は維持（契約25 keep） ----
    // 壁の額（+z 壁に 5 枚のギャラリー）: 額縁 + 単色の抽象画パネル。高さ違いで賑やかに。
    const artColors = ['#3f6ea5', '#8a6f3a', '#5b7a4a', '#a84a6f', '#4a6f86'];
    for (let i = 0; i < 5; i++) {
      const ax = -4.4 + i * 2.2;
      const ah = i % 2 ? 1.5 : 1.1;
      boxP(woodDark, 1.5, ah + 0.25, 0.08, ax, floorY + 3.4, wallZ - 0.05); // 額縁
      boxP(artColors[i]!, 1.3, ah, 0.02, ax, floorY + 3.4, wallZ - 0.09); // 画
    }

    // 天井照明: 発光する円盤シェード + 吊り棒 + 左右の小ペンダント（密度向上）。
    const ceilY = floorY + H - 0.15;
    bake(glow, unitCyl.clone(), '#fff0d0', 1.8, 0.14, 1.8, 0, ceilY, 0);
    cylP('#2a2018', 0.05, 0.5, 0, ceilY - 0.35, 0); // 吊り棒
    for (const px of [-3.5, 3.5]) {
      cylP('#2a2018', 0.03, 0.7, px, ceilY - 0.35, 3.2);
      bake(glow, new THREE.ConeGeometry(0.3, 0.4, 16, 1, true), '#ffe6b0', 1, 1, 1, px, ceilY - 0.7, 3.2, Math.PI);
    }

    // 天井の梁（項目6・密度向上）: 木の梁を格子状に（縦2 + 横2）。中央の吊り照明を避けて配置。
    for (const bx of [-5, 5]) boxP(woodDark, 0.3, 0.3, wallZ * 2 - 1.2, bx, ceilY - 0.12, 0);
    for (const bz of [-5, 5]) boxP(woodDark, wallZ * 2 - 1.2, 0.26, 0.26, 0, ceilY - 0.1, bz);

    swap = true; // ---- Meshy サイドボードで差し替わる区間（天板小物ごと・契約25） ----
    // サイドボード + 小物（+z 壁・額の下）: キャビネット + 引き出し + 花瓶/積み本/食器/置時計/燭台（項目6）。
    const sbY = floorY + 0.55;
    const sbZ = wallZ - 0.42;
    boxP(woodMid, 4.4, 1.1, 0.7, 0, sbY, sbZ); // 本体
    boxP(woodDark, 4.5, 0.12, 0.78, 0, sbY + 0.6, sbZ); // 天板
    for (const dx of [-1.5, -0.5, 0.5, 1.5]) boxP('#2a1e12', 0.9, 0.7, 0.04, dx, sbY, sbZ - 0.34); // 引き出し面
    for (const dx of [-1.5, -0.5, 0.5, 1.5]) cylP('#b8a06a', 0.04, 0.12, dx, sbY, sbZ - 0.4); // 取っ手
    cylP('#7a9bb0', 0.13, 0.5, -1.7, sbY + 0.9, sbZ); // 花瓶
    cylP('#c9a23a', 0.05, 0.35, -1.7, sbY + 1.25, sbZ); // 花瓶の花（茎）
    boxP('#b5462f', 0.5, 0.28, 0.34, 1.6, sbY + 0.78, sbZ); // 積み本
    boxP('#3f6ea5', 0.44, 0.2, 0.3, 1.6, sbY + 0.98, sbZ); // 積み本（上）
    // 食器（皿の重ね + ボウル + 器）: 薄い円柱の積み重ね（食卓感の小物・項目4）。
    for (let p = 0; p < 3; p++) cylP('#e8e0d2', 0.22 - p * 0.02, 0.03, -0.7, sbY + 0.68 + p * 0.04, sbZ);
    cylP('#c26b3a', 0.18, 0.16, -0.2, sbY + 0.74, sbZ); // ボウル
    cylP('#6b8f9a', 0.12, 0.2, 0.5, sbY + 0.76, sbZ); // 器
    // 置時計（サイドボード上・小物）: 枠 + 発光文字盤。
    boxP(woodDark, 0.4, 0.5, 0.18, 0.9, sbY + 0.9, sbZ); // 時計筐体
    bake(glow, unitPlane.clone(), '#fef0c8', 0.26, 0.32, 1, 0.9, sbY + 0.92, sbZ - 0.1);
    // 燭台（発光の炎付き・両端）。
    for (const cx of [-2.0, 2.0]) {
      cylP('#b8a06a', 0.05, 0.4, cx, sbY + 0.86, sbZ);
      bake(glow, new THREE.ConeGeometry(0.05, 0.14, 8), '#ffcf7a', 1, 1, 1, cx, sbY + 1.12, sbZ);
    }

    swap = false; // ---- 壁掛け時計は維持（契約25 keep） ----
    // 壁掛け時計（-x 壁・ソファ上）: 丸い文字盤 + 針。首振りで側方を見たときのアクセント（項目6）。
    const clockX = -wallZ + 0.12;
    const clockY = floorY + 4.2;
    bake(glow, new THREE.CylinderGeometry(0.5, 0.5, 0.08, 24), '#f3ead2', 1, 1, 1, clockX, clockY, 1.0, 0, 0, Math.PI / 2);
    bake(opaque, new THREE.TorusGeometry(0.5, 0.05, 10, 28), '#2a1e12', 1, 1, 1, clockX + 0.02, clockY, 1.0, 0, Math.PI / 2, 0);
    boxP('#1b1610', 0.03, 0.34, 0.04, clockX + 0.06, clockY + 0.08, 1.0); // 長針
    boxP('#1b1610', 0.03, 0.04, 0.24, clockX + 0.06, clockY, 1.0); // 短針

    swap = true; // ---- Meshy カゴ/プフ/フロアランプで差し替わる区間（契約25） ----
    // 床の小物（生活感の密度・項目4）: 積み雑誌 + 収納カゴ + 丸いプフ（オットマン）。
    boxP('#4d7a4a', 0.9, 0.12, 0.7, -2.5, floorY + 0.06, -2.5); // 雑誌の山
    boxP('#c9a23a', 0.85, 0.1, 0.66, -2.55, floorY + 0.18, -2.45, 0.15);
    cylP('#8a6f4a', 0.4, 0.5, 3.0, floorY + 0.25, -3.2); // 収納カゴ
    cylP('#a84a6f', 0.55, 0.45, 3.2, floorY + 0.22, 2.8); // 丸プフ

    // フロアスタンドライト（+x/-z 角・本棚と窓の間）: 台 + 支柱 + 発光シェード（項目6・照明で加点）。
    const flX = wallZ - 1.0;
    const flZ = -wallZ + 1.2;
    cylP('#20242b', 0.28, 0.1, flX, floorY + 0.05, flZ); // 台座
    cylP('#20242b', 0.05, 2.4, flX, floorY + 1.2, flZ); // 支柱
    bake(glow, new THREE.CylinderGeometry(0.34, 0.42, 0.6, 20, 1, true), '#ffe6b0', 1, 1, 1, flX, floorY + 2.5, flZ); // シェード
    swap = false;

    // ---- 2バケットを統合し、シーンへ最少メッシュで追加（契約20項目4の中核） ----
    const opaqueMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    const flush = (bucket: THREE.BufferGeometry[], material: THREE.Material, collect?: THREE.Mesh[]): void => {
      if (!bucket.length) return;
      if (MERGE_FURNITURE) {
        const merged = mergeGeometries(bucket, false); // useGroups=false ＝ 1グループ＝1描画コール
        for (const g of bucket) g.dispose?.(); // 統合済みの中間ジオメトリを解放（頂点は merged が保持）
        const mesh = new THREE.Mesh(merged, material);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        this.scene.add(mesh);
        collect?.push(mesh);
      } else {
        // 計測用（統合前）: 各プリミティブを個別メッシュで置く＝統合前の描画コール数になる。
        for (const g of bucket) {
          const mesh = new THREE.Mesh(g, material);
          mesh.castShadow = false;
          mesh.receiveShadow = false;
          this.scene.add(mesh);
          collect?.push(mesh);
        }
      }
    };
    flush(opaque, opaqueMat);
    flush(glow, glowMat);
    // swap バケットは keep とマテリアルを共有しない（除去時に dispose するため・契約25）。
    flush(swapOpaque, opaqueMat.clone(), this.swapFurniture);
    flush(swapGlow, glowMat.clone(), this.swapFurniture);
    this.loadRoomFurniture();
    unitBox.dispose?.();
    unitCyl.dispose?.();
    unitPlane.dispose?.();

    // 照明: 環境光/半球光は buildEnvironment で全ティア明るめ。ここでは温かみの点光源を足す。
    // 高ティアは窓＋ランプ＋天井の3点光源、低ティアは天井1点に絞って軽量化（ジオメトリは同一・U1）。
    const ceilingLight = new THREE.PointLight(0xfff0d0, this.quality.name === 'low' ? 18 : 14, 20, 2);
    ceilingLight.position.set(0, ceilY - 0.5, 0);
    this.scene.add(ceilingLight);
    if (this.quality.name !== 'low') {
      // 契約31: 床の法線マップが陰影を得られるよう窓光を強化し、床を斜めに横切る角度にする
      const windowLight = new THREE.DirectionalLight(0xffcf94, 0.6);
      windowLight.position.set(-3, winY, -6);
      windowLight.target.position.set(2.5, -0.5, 4);
      this.scene.add(windowLight);
      this.scene.add(windowLight.target);
      const lamp = new THREE.PointLight(0xffb066, 10, 12, 2);
      lamp.position.set(stX, floorY + 1.75, stZ);
      this.scene.add(lamp);
      // フロアスタンドライトの点光源（項目6の追加照明・角を暖める）。
      const floorLamp = new THREE.PointLight(0xffd9a0, 8, 11, 2);
      floorLamp.position.set(flX, floorY + 2.4, flZ);
      this.scene.add(floorLamp);
    }

    // ユーザーのぬいぐるみ2体（契約23）: ソファ座面の上に肩が触れる距離で並べて座らせる。
    // 座面上面 = floorY + 0.7（座面 box: 中心 floorY+0.35・高さ0.7）。中心 X = sofaX（= -wallZ + 1.0）。
    // Z 中心はソファ中央(z=2)付近。全パーツは既定レイヤ(0)・cast/receive shadow=false ＝ Bloom非対象(E2)で
    // 部屋の光に馴染む。統合済みで +2 描画コールのみ（drawCalls は getRenderStats の calls に含まれる）。
    const plush = buildPlushDolls(floorY + 0.7, -wallZ + 1.0, 2.0);
    this.scene.add(plush.group);
    // Meshy 生成の高品質 GLB があれば差し替える（無ければプロシージャル版のまま・契約24）。
    this.loadPlushGlbs(plush.group, floorY + 0.7, -wallZ + 1.0, 2.0);
  }

  /**
   * 契約25(R27): Meshy 家具の統合 GLB（1メッシュ・1マテリアル・1アトラス＝+1描画コール）を
   * 非同期ロードし、成功時のみプロシージャル家具の swap バケットを除去・解放する。
   * 404/失敗時は何もしない（プロシージャル版フォールバック）。頂点はワールド座標へ焼き込み済み
   * なので原点に置くだけでよい。影・Bloom は家具の既定方針どおり不参加（cast/receive=false・レイヤ0）。
   */
  private loadRoomFurniture(): void {
    const loader = new GLTFLoader();
    const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
    loader.load(
      `${base}models/room-furniture.glb`,
      (gltf) => {
        const root = gltf.scene;
        root.traverse((o: THREE.Object3D) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = false;
            mesh.receiveShadow = false;
          }
        });
        this.scene.add(root);
        this.roomGlb = root;
        for (const mesh of this.swapFurniture) {
          this.scene.remove(mesh);
          mesh.geometry?.dispose?.();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) m.dispose?.();
        }
        this.swapFurniture = [];
        // 家具の実サーフェスが確定したので、隠れぬいぐるみを接地スナップ込みで置き直す（契約29）。
        const seed = this.hideSeed;
        if (seed) {
          this.hideSeed = null;
          this.setHideSeed(seed);
        }
      },
      undefined,
      () => {
        /* フォールバック: プロシージャル家具のまま */
      },
    );
  }

  /**
   * 契約26(R28): かくれんぼの共有シードを注入する。「ルームコード#ラウンド」のように全クライアントが
   * 独立に同じ値を導出できる文字列を渡すこと（候補地リストは純計算で全端末同一 → シードが同じなら
   * 配置も同一＝プロトコル変更なしで同期する）。シードが変わるたび（＝ラウンド毎）に置き直す。
   */
  setHideSeed(seed: string): void {
    if (this.hideSeed === seed) return;
    this.hideSeed = seed;
    this.placeHiddenPlush();
  }

  /** 隠れパンダ+隠れダルメシアンを配置する（シードと両クローン元が揃うまでは何もしない）。 */
  private placeHiddenPlush(): void {
    const panda = this.plushSrc.panda;
    const dal = this.plushSrc.dalmatian;
    if (!this.hideSeed || !panda || !dal || HIDE_SPOTS.length < 2) return;
    for (const o of this.hiddenPlush) {
      this.plushReactions?.unregister(o);
      this.scene.remove(o); // ジオメトリ/マテリアルはクローン元と共有＝dispose しない（E3）
    }
    this.hiddenPlush = [];
    const order = shuffle(HIDE_SPOTS as HideSpot[], hashSeed(this.hideSeed)).result;
    const first = order[0]!;
    // 2体目は1体目から3m以上離れた最初の候補（固まって出ると1回で両方見つかるため）。
    const second = order.find((p, i) => i > 0 && Math.hypot(p.x - first.x, p.z - first.z) >= 3) ?? order[1]!;
    const picks: [HideSpot, 'panda' | 'dalmatian'][] = [
      [first, 'panda'],
      [second, 'dalmatian'],
    ];
    // 難化ジッター（2026-08-12 ユーザー要望・難度8へ強化）: 同じシードから決定的に導出する
    // 向き±30°とスケール0.75〜0.95の揺らぎ（縮小方向）。全クライアント同一（同期安全）。
    let rs = hashSeed(`${this.hideSeed}#jitter`);
    const rnd = (): number => {
      const step = nextRng(rs);
      rs = step.state;
      return step.value;
    };
    for (const [p, kind] of picks) {
      const jittered: HideSpot = {
        ...p,
        yaw: p.yaw + (rnd() - 0.5) * 1.05,
        s: Math.max(0.28, p.s * (0.75 + rnd() * 0.2)),
      };
      const clone = this.placeCloneAt(jittered, kind === 'panda' ? panda : dal);
      this.hiddenPlush.push(clone);
      // 発見＝ズーム注視の初回リアクション発火。以降の再注視はリアクションのみ（通知は一度だけ）。
      let found = false;
      this.plushReactions?.register(kind, clone, () => {
        if (found) return;
        found = true;
        this.onHiddenFound?.(kind);
      });
    }
    this.wake();
  }

  /**
   * 候補地 p へクローンを接地配置してシーンへ加える（かくれんぼ本配置と検証プローブの共通部・契約29）。
   * バウンディング底面→接地面、その後 家具GLBの実サーフェスへ下向きレイキャストで吸着。
   */
  private placeCloneAt(p: HideSpot, src: THREE.Object3D): THREE.Object3D {
    const clone = src.clone(true);
    clone.rotation.set(0, p.yaw, 0);
    clone.scale.multiplyScalar(p.s);
    clone.position.set(p.x, 0, p.z);
    clone.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(clone);
    clone.position.y += p.y - bb.min.y; // バウンディング底面を候補地の接地面へ
    // 接地スナップ（契約29）: 実サーフェス（棚段・天面・座面）へ吸着し目測高さの誤差を吸収。
    // スポット選択はシード同期のまま＝吸着は各端末の見た目補正のみで同期に影響しない。
    let baseY = p.y;
    if (this.roomGlb) {
      const ray = new THREE.Raycaster();
      ray.set(new THREE.Vector3(p.x, p.y + 0.6, p.z), new THREE.Vector3(0, -1, 0));
      const hit = ray
        .intersectObject(this.roomGlb, true)
        .find((h: { point: { y: number } }) => h.point.y > p.y - 0.35 && h.point.y < p.y + 0.55);
      if (hit) {
        clone.position.y += hit.point.y - p.y;
        baseY = hit.point.y;
      }
      // 頭上クリアランス自動縮小（契約31・2026-08-12 干渉報告の根本対策）: 接地点から真上へ
      // レイキャストし、上の棚板等までの空きが個体の高さ+余白に足りなければ収まるまで縮小する。
      // モデル形状（パンダ/ダルメシアンの耳など）に依らずどの個体でも干渉しない。見た目補正のみ＝同期無関係。
      clone.updateMatrixWorld(true);
      const bb2 = new THREE.Box3().setFromObject(clone);
      const height = bb2.max.y - bb2.min.y;
      ray.set(new THREE.Vector3(p.x, baseY + 0.03, p.z), new THREE.Vector3(0, 1, 0));
      const up = ray.intersectObject(this.roomGlb, true).find((h: { distance: number }) => h.distance > 0.05);
      if (up && up.distance < height * 1.12) {
        const k = Math.max(0.55, (up.distance * 0.88) / height);
        clone.scale.multiplyScalar(k);
        clone.updateMatrixWorld(true);
        const bb3 = new THREE.Box3().setFromObject(clone);
        clone.position.y += baseY - bb3.min.y; // 縮小後に再接地
      }
      // 最終沈降（契約32・2026-08-12 浮き報告の根本対策）: バウンディング底面直下の実サーフェスとの
      // 隙間を実測し、浮いていれば着地させる（スナップが天面の縁など誤った面を掴んだケースを吸収）。
      clone.updateMatrixWorld(true);
      const bb4 = new THREE.Box3().setFromObject(clone);
      ray.set(new THREE.Vector3(p.x, bb4.min.y + 0.02, p.z), new THREE.Vector3(0, -1, 0));
      const below = ray.intersectObject(this.roomGlb, true)[0] as { point: { y: number } } | undefined;
      const surfaceY = Math.max(below ? below.point.y : -0.45, -0.45); // 素の床＝影受け円盤の面（契約32）
      const gap = bb4.min.y - surfaceY;
      if (gap > 0.04 && gap < 0.7) clone.position.y -= gap;
    }
    clone.updateMatrixWorld(true);
    this.scene.add(clone);
    return clone;
  }

  /**
   * public/models/{panda,dalmatian}.glb を非同期ロードし、成功した個体だけプロシージャル版と
   * 差し替える（404/失敗は無視＝フォールバック）。モデルはバウンディングボックスから座高を
   * 正規化し、ソファ座面へ接地・部屋中央向きに配置する。
   */
  private loadPlushGlbs(proceduralGroup: THREE.Object3D, seatTopY: number, seatCenterX: number, zCenter: number): void {
    const loader = new GLTFLoader();
    const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? './';
    // 「見つめると反応する」リアクション（契約24）。両体ともボーンレスの transform 演出。
    this.plushReactions = new PlushReactions(this.particles);
    this.plushReactions.onSfx = (k) => this.onPlushReaction?.(k);
    const targetHeight = 1.05; // 座高（契約24調整: 従来1.4の0.75倍）
    const place = (obj: THREE.Object3D, z: number, kind: 'dalmatian' | 'panda'): void => {
      const box = new THREE.Box3().setFromObject(obj);
      const size = new THREE.Vector3();
      box.getSize(size);
      const s = targetHeight / Math.max(size.y, 0.001);
      obj.scale.setScalar(s);
      box.setFromObject(obj);
      // 接地: バウンディング底面を座面へ。背クッション（sofaX+0.2）より前へ出し、少し上げて埋もれ回避
      // （契約24調整: 従来は背もたれ側 -0.1 で背クッションに埋もれていた）。
      obj.position.set(seatCenterX + 0.55 - (box.min.x + box.max.x) / 2 + obj.position.x, seatTopY + 0.1 - box.min.y + obj.position.y, z - (box.min.z + box.max.z) / 2 + obj.position.z);
      obj.rotation.y = Math.PI / 2; // 部屋中央（+X方向）を向く
      obj.traverse((o: THREE.Object3D) => {
        o.castShadow = false;
        o.receiveShadow = false;
        o.layers.set(0);
      });
      this.scene.add(obj);
      this.plushGlbs.push(obj);
      this.plushReactions?.register(kind, obj); // リアクション対象として登録（契約24）
      // かくれんぼのクローン元として保持し、シードが既に来ていれば配置を試みる（契約26）。
      this.plushSrc[kind] = obj;
      this.placeHiddenPlush();
    };
    // 最初の1体が読めた時点でプロシージャル版を非表示（重なり防止）。両方失敗ならそのまま残る。
    const hideProcedural = (): void => {
      proceduralGroup.visible = false;
    };
    loader.load(
      `${base}models/panda.glb`,
      (gltf) => {
        hideProcedural();
        place(gltf.scene, zCenter + 0.45, 'panda');
      },
      undefined,
      () => undefined,
    );
    loader.load(
      `${base}models/dalmatian.glb`,
      (gltf) => {
        hideProcedural();
        place(gltf.scene, zCenter - 0.45, 'dalmatian');
      },
      undefined,
      () => undefined,
    );
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
    // 材質はカードごとに複製する（opacity を個別に動かすため・Q5/Q6/U3）。マップ（テクスチャ）は
    // クローンでも参照共有されるので重い資源は増えない。transparent=true / depthWrite=true 固定で、
    // 定常時 opacity=1 のとき不透明カードと同一に描画される（メルド段差の Z 整合を保つ・E7）。
    const mats: THREE.Material[] = [];
    const prep = <T extends THREE.Material>(src: T): T => {
      const m = src.clone() as T & { transparent: boolean; depthWrite: boolean; opacity: number };
      m.transparent = true;
      m.depthWrite = true;
      m.opacity = 1;
      mats.push(m);
      return m as unknown as T;
    };
    const body = new THREE.Mesh(this.bodyGeo, prep(this.bodyMat));
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // 裏面(-z)は常に裏デザイン（契約22項目1）。デモの手札もこれで「外側＝裏面／持ち主側＝表」の通常カード
    // になり、実対局と同じ見え方（他プレイヤー・カメラ側は裏）に戻る。両面表（旧 faceBoth）は撤去した。
    const back = new THREE.Mesh(this.planeGeo, prep(this.backMat));
    back.rotation.y = Math.PI;
    back.position.z = -(CARD_D / 2 + 0.006); // 本体面から十分に離し共面を避ける
    g.add(back);

    if (card) {
      const front = new THREE.Mesh(this.planeGeo, prep(this.frontMat(card)));
      front.position.z = CARD_D / 2 + 0.006;
      g.add(front);
    }
    g.userData.cardMats = mats;
    return g;
  }

  /** カード群の現在 opacity を材質へ反映し、ほぼ透明なら非表示にする（描画節約）。 */
  private applyCardOpacity(obj: CardObj): void {
    const o = obj.opacity;
    for (const m of obj.mats) (m as THREE.Material & { opacity: number }).opacity = o;
    obj.group.visible = o > 0.008;
  }

  /** カード1枚分の複製材質を破棄（共有テクスチャは material.dispose では解放されないので安全・E6）。 */
  private disposeCardMats(obj: { mats: THREE.Material[] }): void {
    for (const m of obj.mats) m.dispose();
  }

  /**
   * 1枚のカードを目標へ補間し、出現/退場/遮蔽のフェード（Q5/Q6/U3）とバネ状の出現スケール（Q12）を
   * 適用する。戻り値 done=true で呼び出し側が scene から除去・材質破棄する。
   */
  private animateCard(obj: CardObj, now: number, k: number): { done: boolean; busy: boolean } {
    const age = now - obj.born - obj.delay;
    if (age < 0) return { done: false, busy: true }; // 配札/飛翔ディレイ待ち（不可視のまま）
    obj.spawned = true;
    obj.group.position.lerp(obj.targetPos, k);
    obj.group.quaternion.slerp(obj.targetQuat, k);
    // 不透明度: 退場0 / 遮蔽0 / 通常1 へ追従。出現（フェードイン）は速めにして、短い飛翔（付け札/メルド公開）
    // でも「操作者の手元→場」の移動中にカードが見えるようにする（契約19項目1: 移動が消滅に見えないよう）。
    // 退場/遮蔽のフェードアウトは従来どおり穏やか（ちらつき防止）。
    const targetOp = obj.removing ? 0 : obj.occluded ? 0 : 1;
    const ko = Math.min(1, k * (targetOp > obj.opacity ? 2.9 : 1.7));
    let busy = false;
    if (Math.abs(obj.opacity - targetOp) > 0.002) {
      obj.opacity += (targetOp - obj.opacity) * ko;
      busy = true;
    } else {
      obj.opacity = targetOp;
    }
    this.applyCardOpacity(obj);
    if (obj.removing) {
      const s = obj.group.scale.x;
      obj.group.scale.setScalar(s + (obj.targetScale * 0.86 - s) * k); // ほのかに縮めながら退場
      if (obj.opacity < 0.02) return { done: true, busy: false };
      return { done: false, busy: true };
    }
    if (age < ENTRANCE_MS) {
      const t = age / ENTRANCE_MS;
      obj.group.scale.setScalar(obj.targetScale * (0.5 + 0.5 * easeOutBack(t))); // バネのポップイン
      busy = true;
    } else {
      const s = obj.group.scale.x;
      if (Math.abs(s - obj.targetScale) > 0.001) {
        obj.group.scale.setScalar(s + (obj.targetScale - s) * k); // メルド再配置のスケール追従
        busy = true;
      }
    }
    return { done: false, busy };
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
      // Z ファイト対策（契約21項目4）: 旧実装は中央基準の距離 |t| で法線方向(dir)の段差を付けていたため、
      // 中央対称の隣接札（例: t=-0.5 と +0.5）が同一深度に載って重なり Z ファイトした。深度段差を
      // 「左から右への単調順」= t（k に単調）にして、隣接札が必ず異なる深度に並ぶようにする。カードは
      // ほぼ立っている（tilt≈直立）ので法線は概ね水平(dir)方向＝dir へ単調に押すと深度が確実に分離する。
      const p = anchor
        .clone()
        .addScaledVector(tangent, t * spacing)
        .add(new THREE.Vector3(0, -Math.abs(t) * 0.02, 0)) // 端ほど僅かに下げ弧を描く（面内・深度には効かない）
        .addScaledVector(dir, t * 0.016); // 左→右の単調な深度段差（隣接札を確実に前後へ分離＝Zファイト解消）
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
    // 公開/付け札の操作者席（＝現手番席）。新規メルドカードの飛翔スポーン元に使う（契約19項目1）。
    // メルド所有者(meld.owner)ではなく「今このカードを場に出した席」から飛ばすのが正しい: 付け札は
    // 他家メルドへ自分の手から付けるため、owner基準だと別席の手から湧いて「カード消滅/瞬間移動」に見える。
    // 公開時は owner==現手番なので従来どおり所有者の手から出る（回帰なし）。
    const curSeat = view.seats.find((s) => s.isCurrent)?.index ?? view.youIndex;

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
      // メルド配置（契約18項目4: 同一メルドは1行・収まらなければ縮小）。自席は付け札のため内側バンドへ寄せる。
      const layout = layoutSeatMelds(this.seatCount, dir.x, inputs, seat === this.viewYou);
      const halfW = (Math.max(CARD_W, CARD_H) / 2) * layout.scale;
      // 公開/付け札で新規に現れるメルドカードは、操作者席（現手番＝curSeat）の手（自席=2D手札位置 /
      // 他家=空中手札）から飛ばす（契約14項目5・契約19項目1）。既存カードの再配置では spawnPos は無視される。
      const meldSpawn = this.actorSpot(curSeat);
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
    if (!this.userControlled && !this.cinematic) this.aimCameraAt(view.youIndex);
    // 手番スポットは「現手番の席」を照らす（通信対戦では youIndex と別席になり得る・curSeat は上で算出）
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
    // 自席の手番では光だまりを控えめに（契約17項目2）。自分の番は 2D 手札・手番バナーで自明。
    this.activeSeatSelf = seatIndex === this.viewYou;
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
      group.scale.setScalar(targetScale * 0.5); // 出現ポップ（loop で easeOutBack により targetScale へ）
      group.visible = false; // opacity 0 スタート（loop の初回でフェードイン開始）
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
        mats: group.userData.cardMats as THREE.Material[],
        opacity: 0,
        occluded: false,
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

    // 手番の光だまり（契約17項目2）: 現手番席の卓上に置く柔らかな金色ディスク。加算合成で床が仄かに
    // 照らされて見える。青みを抑えた金（白飛びしない）にして「白い円」感を解消する。
    this.spotGlow = new THREE.Mesh(
      new THREE.CircleGeometry(1.15, 40),
      new THREE.MeshBasicMaterial({
        color: '#ffb64a',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.spotGlow.rotation.x = -Math.PI / 2;
    this.spotGlow.position.set(0, TABLE_TOP_Y + 0.021, 0);
    this.spotGlow.renderOrder = 2;
    this.scene.add(this.spotGlow);
    // 光だまりを縁取る細い金環。塗りだけだと「何の円？」になりがちなので、輪郭で手番マーカーだと示す。
    this.spotRing = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.24, 48),
      new THREE.MeshBasicMaterial({
        color: '#ffd27a',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.spotRing.rotation.x = -Math.PI / 2;
    this.spotRing.position.set(0, TABLE_TOP_Y + 0.022, 0);
    this.spotRing.renderOrder = 2;
    this.spotRing.layers.enable(BLOOM_LAYER);
    this.scene.add(this.spotRing);

    // 鳴きウィンドウ開始ハイライト（Q11）: 捨て札上の脈動リング。発光として滲ませる。
    this.claimRing = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.56, 44),
      new THREE.MeshBasicMaterial({
        color: '#9fd8ff',
        transparent: true,
        opacity: 0,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.claimRing.rotation.x = -Math.PI / 2;
    this.claimRing.position.set(DISCARD_C.x, TABLE_TOP_Y + 0.1, DISCARD_C.z);
    this.claimRing.renderOrder = 32;
    this.claimRing.visible = false;
    this.claimRing.layers.enable(BLOOM_LAYER);
    this.scene.add(this.claimRing);
  }

  /** 鳴きウィンドウ開始演出（Q11）: 対象の捨て札を3Dハイライト（app.ts が開始/終了を通知）。 */
  showClaimFocus(): void {
    this.claimFocusActive = true;
    this.claimRing.visible = true;
    this.wake();
  }

  hideClaimFocus(): void {
    this.claimFocusActive = false;
    this.claimRing.visible = false;
    (this.claimRing.material as THREE.MeshBasicMaterial).opacity = 0;
  }

  /** 捨て札の着地の手応え（Q2）: 小さな砂塵バーストと微小な着地リング。app.ts が新規捨て札で呼ぶ。 */
  discardImpact(): void {
    const p = new THREE.Vector3(DISCARD_C.x, TABLE_TOP_Y + 0.06, DISCARD_C.z);
    this.particles.burst(p, { count: 14, color: [0.86, 0.82, 0.72], speed: 1.5, size: 0.06, life: 0.42, spread: 0.85, gravity: 2.2, drag: 2.2 });
    this.spawnRing(p, '#e8e0cc', { r0: 0.15, r1: 0.9, dur: 0.34, opacity: 0.5 });
    this.wake();
  }

  /**
   * タイトル背景デモの手札公開（契約20項目2）。全席の実手札（席index→カード列）を渡すと、次回以降の
   * update() で裏向き浮遊札の代わりに実絵柄を表向きで浮かべる。null で通常（裏向き）へ戻す。デモ専用で、
   * 実対局では呼ばれない＝通常対局の秘匿（他家手札は枚数のみ）には一切影響しない（E2）。
   */
  setDemoReveal(hands: Map<number, Card[]> | null): void {
    this.demoHands = hands;
  }

  /** タイトル背景のデモ対局用: シネマティックカメラの有効化（U4/契約19項目5）。 */
  setCinematic(on: boolean): void {
    this.cinematic = on;
    if (on) {
      this.userControlled = false;
      this.cineShotIdx = 0;
      this.cineShotT = 0;
      this.cineBaseYaw = Math.random() * Math.PI * 2;
      // 初期カットの開始画をセットし、位置をスナップ（冒頭は黒フェードインなのでスナップは見えない）。
      this.cineShots[0]!.cam(0, this.cineBaseYaw, this.camPosGoal, this.camTargetGoal);
      this.camPos.copy(this.camPosGoal);
      this.camTarget.copy(this.camTargetGoal);
      if (!this.cineFadeEl) {
        const f = document.createElement('div');
        // デモ卓（canvas）の上に重なる黒幕。タイトルUI（root 直下の別要素・高い z-index）の下に留まる。
        f.style.cssText = 'position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:1;';
        this.container.appendChild(f);
        this.cineFadeEl = f;
      }
      this.resize(); // シネマ用の低DPRを即時適用（契約19項目3）
    }
    this.wake();
  }

  /** シネマカット用のオービット座標（yaw/pitch/半径 → ワールド位置）。 */
  private cineOrbit(yaw: number, pitch: number, r: number, out: THREE.Vector3): void {
    const cp = Math.cos(pitch);
    out.set(r * cp * Math.cos(yaw), r * Math.sin(pitch), r * cp * Math.sin(yaw));
  }

  // シネマティックのカット定義（契約19項目5）。各カットは尺 dur 秒、u=0..1 の局所進行でカメラ位置(pos)/
  // 注視点(target)を決める。卓中心は原点付近。ドリー・ロー/ハイアングル・卓面トラッキングを織り交ぜる。
  private readonly cineShots: {
    dur: number;
    cam: (u: number, baseYaw: number, pos: THREE.Vector3, target: THREE.Vector3) => void;
  }[] = [
    // 1. 高めの俯瞰をゆっくり周回（establishing）。
    { dur: 11, cam: (u, y, p, t) => { this.cineOrbit(y + u * 0.5, 0.64, 8.8, p); t.set(0, 0.1, 0); } },
    // 2. 卓面すれすれのロー・トラッキング（横へ流す）。
    { dur: 8, cam: (u, y, p, t) => { this.cineOrbit(y + 0.5 + u * 0.55, 0.11, 5.6, p); t.set(0, 0.32, 0); } },
    // 3. ハイアングルの見下ろし（ゆっくり回す）。
    { dur: 8, cam: (u, y, p, t) => { this.cineOrbit(y - 0.35 + u * 0.4, 1.14, 7.4, p); t.set(0, 0, 0); } },
    // 4. ドリーイン（寄り）。
    { dur: 7, cam: (u, y, p, t) => { this.cineOrbit(y + 1.2, 0.5, 9.4 - u * 4.4, p); t.set(0, 0.12, 0); } },
    // 5. ドリーアウト（引き）＋僅かに回す。
    { dur: 9, cam: (u, y, p, t) => { this.cineOrbit(y + 2.1 + u * 0.22, 0.42, 5.2 + u * 4.6, p); t.set(0, 0.15, 0); } },
  ];

  /** 毎フレームのシネマ更新: カット進行・境界での黒フェードとスナップ切替（契約19項目5）。 */
  private stepCinematic(dt: number): void {
    this.cineShotT += dt;
    let shot = this.cineShots[this.cineShotIdx]!;
    if (this.cineShotT >= shot.dur) {
      // カット切替。黒フェード最中（fade≈1）に位置をスナップ＝スウィープでなく「カット」になる。
      this.cineShotT = 0;
      this.cineShotIdx = (this.cineShotIdx + 1) % this.cineShots.length;
      this.cineBaseYaw += 1.7; // カットごとに方位をずらし単調さを避ける
      shot = this.cineShots[this.cineShotIdx]!;
      shot.cam(0, this.cineBaseYaw, this.camPosGoal, this.camTargetGoal);
      this.camPos.copy(this.camPosGoal);
      this.camTarget.copy(this.camTargetGoal);
    } else {
      shot.cam(this.cineShotT / shot.dur, this.cineBaseYaw, this.camPosGoal, this.camTargetGoal);
    }
    // カット境界の黒フェード: 冒頭 fadeDur 秒でフェードイン、末尾 fadeDur 秒でフェードアウト。
    const fadeDur = 0.6;
    let fade = 0;
    if (this.cineShotT < fadeDur) fade = 1 - this.cineShotT / fadeDur;
    else if (this.cineShotT > shot.dur - fadeDur) fade = (this.cineShotT - (shot.dur - fadeDur)) / fadeDur;
    if (this.cineFadeEl) this.cineFadeEl.style.opacity = clamp(fade, 0, 1).toFixed(3);
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
    this.dropHiding = false; // 再表示でフェード中なら打ち切る
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
    // 論理側（付け札可否判定）は即時に無効化し、視覚のリングだけ短くフェードアウトさせる（Q15）。
    this.attachableMelds.clear();
    if (!this.dropActive && !this.dropHiding) return;
    this.dropActive = false;
    this.dropHiding = true;
    this.dropHideAt = performance.now();
    this.wake();
  }

  /** ドロップ光枠のフェードアウト完了時に実際に片付ける（loop から呼ぶ・Q15）。 */
  private finishHideDropTargets(): void {
    this.dropHiding = false;
    this.discardRing.visible = false;
    this.fieldRing.visible = false;
    (this.discardRing.material as THREE.MeshBasicMaterial).opacity = 0;
    (this.fieldRing.material as THREE.MeshBasicMaterial).opacity = 0;
    this.clearMeldRings();
    this.dropRings = [];
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
    // 席ごとの確定累計失点（契約20項目3②）。scores を縦合計（app.ts の seatTotals と同一集計だが、
    // render→ui の逆依存を避けるためここは同式をインラインで持つ）。値変化はキーに載せ、既存の
    // クロスフェード（Q8）でさりげなく更新演出になる。
    const totals = new Array<number>(n).fill(0);
    for (const row of view.scores) for (let i = 0; i < n; i++) totals[i]! += row[i] ?? 0;
    for (const seat of view.seats) {
      const score = totals[seat.index] ?? 0;
      // 手番強調(isCurrent)はキーから外す（契約21項目7）: 名前/失点の変化はテクスチャ差替（クロスフェード）、
      // 手番色は phase を左→右に流す 2 色ワイプで別途アニメする。両者を混ぜると差替のたびにワイプが飛ぶ。
      const key = `${seat.name}|${score}`;
      let L = this.labels.get(seat.index);
      if (!L) {
        const phase = seat.isCurrent ? 1 : 0;
        const tex = this.makeLabelTexture(seat.name, score, phase);
        // 席名ラベルは手札やカードより常に優先して見える（U2）: depthTest=false + 高い renderOrder で
        // 浮遊手札の裏面に隠れず最前面へ描く。可読性が勝つ。
        const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
        const sprite = new THREE.Sprite(mat);
        sprite.renderOrder = 60;
        this.scene.add(sprite);
        L = {
          sprite, tex, mat, key, basePos: new THREE.Vector3(), opacity: 0, opacityTarget: 1, behind: false,
          current: seat.isCurrent, phase, phaseTarget: phase, name: seat.name, score,
        };
        this.labels.set(seat.index, L);
      } else if (L.key !== key) {
        // 名前変更・累計失点の更新はテクスチャ差替。opacity を一度沈めてから戻しクロスフェード（Q8）。
        // 手番色ワイプの現在 phase を保って描き直す（差替中もワイプ状態が保たれる）。
        L.tex.dispose();
        L.name = seat.name;
        L.score = score;
        L.tex = this.makeLabelTexture(seat.name, score, L.phase);
        L.mat.map = L.tex;
        L.mat.needsUpdate = true;
        L.key = key;
        L.opacity = Math.min(L.opacity, 0.25);
      }
      // 手番の獲得/喪失を検出して 2 色ワイプを開始（契約21項目7）。高速交代（鳴きジャンプ）でも
      // phaseTarget を張り替えるだけで進行中ワイプが新しい目標へ滑らかに向かう（中断→新ワイプ・E3）。
      if (seat.isCurrent !== L.current) {
        L.current = seat.isCurrent;
        L.phaseTarget = seat.isCurrent ? 1 : 0;
      }
      // 自席ラベルは非表示（自分の席は画面下の扇形手札で自明）。ただしデモ(cinematic)では全席を常時表示し、
      // 実対局と同じ手番色（金強調）を見せる（契約21項目6: デモで手番席のプレートが消える不具合の修正）。
      // ホットシートでは youIndex が手番ごとに変わるため、手番席のラベルが隠れる（実対局では意図どおり）。
      if (!this.cinematic && seat.index === view.youIndex) {
        L.opacityTarget = 0;
        continue;
      }
      const dir = this.seatDir(seat.index);
      // 席の外周やや上へ据える（縦画面は視野が狭いので半径・高さを控えめに）。クランプは撤去済み＝
      // 視界外のラベルは画面外へ自然に見切れ、背面のラベルは updateLabelFacing で非表示になる（項目3）。
      L.basePos.copy(dir).multiplyScalar(SEAT_R * (portrait ? 1.0 : 1.12));
      L.basePos.y = TABLE_TOP_Y + (portrait ? 0.58 : 0.72);
      L.sprite.position.copy(L.basePos);
      const s = seat.isCurrent ? 1.18 : 1.0;
      L.sprite.scale.set(1.3 * s, 0.46 * s, 1);
      L.opacityTarget = 1;
    }
    // 席数が減った場合（次ゲームの人数変更等）は余ったラベルをフェードアウト。
    for (const [idx, L] of this.labels) if (idx >= n) L.opacityTarget = 0;
    this.updateLabelFacing();
  }

  /** 席名ラベルの不透明度＋手番色ワイプ(契約21項目7)を目標へ追従させる。loop から毎フレーム（dt=経過秒）。 */
  private stepLabelFades(k: number, dt: number): boolean {
    let busy = false;
    const ko = Math.min(1, k * 1.4);
    // 手番色ワイプは「時間基準」で phase を一定速度に進める（0→1 を約 0.64s＝白→金の二段で塗り切る）。
    // phase は線形に進め、二段のきびきびイージング（easeOutCubic）は makeLabelTexture 側で edge にかける
    // ので、中断→再開（鳴きの高速手番ジャンプで phaseTarget が張り替わっても）phase の連続性だけで破綻なく
    // 追従する（契約22項目3）。reduced-motion（quality.cameraShake=false）では即座に確定する（E3）。
    const WIPE_DUR = 0.64;
    const step = this.quality.cameraShake ? Math.min(1, dt / WIPE_DUR) : 1;
    for (const L of this.labels.values()) {
      // 手番色ワイプ: phase を phaseTarget へ一定速度で寄せ、変化があればテクスチャを描き直す。
      // 手番の高速交代（鳴きジャンプ）では phaseTarget が張り替わり、進行中ワイプが新目標へ折り返す（E3）。
      if (L.phase !== L.phaseTarget) {
        const dir = Math.sign(L.phaseTarget - L.phase);
        L.phase += dir * step;
        if ((dir > 0 && L.phase > L.phaseTarget) || (dir < 0 && L.phase < L.phaseTarget)) L.phase = L.phaseTarget;
        L.tex.dispose();
        L.tex = this.makeLabelTexture(L.name, L.score, L.phase);
        L.mat.map = L.tex;
        L.mat.needsUpdate = true;
        busy = true;
      }
      // カメラ背面のラベルは即 0 へ（背面投影で正面に化けるのを防ぐため target を落とす・契約18項目3）。
      const target = L.behind ? 0 : L.opacityTarget;
      if (Math.abs(L.opacity - target) > 0.004) {
        L.opacity += (target - L.opacity) * ko;
        busy = true;
      } else {
        L.opacity = target;
      }
      L.mat.opacity = L.opacity;
      // 背面のラベルはフェード途中でも描画しない（depthTest=false のスプライトは背面でも最前面に
      // 投影され得るため、可視性はフェードでなく前後判定で確実に切る・契約18項目3）。
      L.sprite.visible = L.opacity > 0.01 && !L.behind;
    }
    return busy;
  }

  /**
   * 席名ラベルを基準位置へ戻し、カメラ前方/背面を判定する（契約18項目3: 画面端クランプ廃止）。
   * クランプ（画面内へ引き戻す処理）は撤去し、視界外のラベルは投影で自然に画面外へ見切れさせる。
   * 唯一の対処は「背面投影」: カメラの後ろにあるラベルは project() で符号が反転し正面へ巨大に化ける
   * ため、視線前方ベクトルとの内積で背面判定し、背面なら非表示にする（stepLabelFades が visible を切る）。
   * カメラのイージング追従に合わせて毎フレーム呼ぶ。
   */
  private updateLabelFacing(): void {
    this.camera.updateMatrixWorld();
    // カメラ視線前方（-Z 列の逆）と現在のカメラ位置。ラベルが前方半空間にあるかで表示可否を決める。
    const fwd = TMP_R.setFromMatrixColumn(this.camera.matrixWorld, 2).negate();
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const camPos = this.camera.position;
    for (const L of this.labels.values()) {
      L.sprite.position.copy(L.basePos); // クランプしない＝そのまま投影（画面外は自然に見切れる）
      const toLabel = TMP_A.subVectors(L.basePos, camPos);
      // 前方成分が僅少以下（真横〜背面）は背面投影の危険域とみなし隠す（正面化けを根絶）。
      L.behind = toLabel.dot(fwd) <= 0.05;
    }
  }

  /**
   * 席名ラベルのテクスチャを生成する。phase（0..1・契約21項目7 / 契約22項目3で二段化）で手番色の
   * ワイプを描く。二段構え＋きびきびイージング（easeOutCubic）で、手番の獲得が「読める」演出になる:
   *  - phase=0: 非手番（暗紺プレート・淡色文字）。phase=1: 手番（金プレート・墨文字）。
   *  - 段1 [phase 0→0.5]: 白（生成り）が左→右へ伸び切る（whiteEdge が 0→全幅）。
   *  - 段2 [phase 0.5→1]: 金が同様に左→右へ追いかけ（goldEdge が 0→全幅）完成する。
   *  常に goldEdge <= whiteEdge。領域ごとに clip して「金→白→紺」の順で三層を描くので、どの進捗でも
   *  名前・失点が読める（白帯上は墨文字・紺地は淡色文字）。逆再生（手番喪失）は金→白の順で引く。
   */
  private makeLabelTexture(name: string, score: number, phase = 0): THREE.CanvasTexture {
    const W = 256;
    const H = 88;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);
    const pad = 8;
    const r = 20;
    const fam = 'system-ui, "Hiragino Kaku Gothic ProN", sans-serif';
    const scoreStr = String(score);

    // 1 枚のプレートを描くヘルパ。mode=配色（idle=非手番紺 / white=先導する生成り帯 / gold=手番金）。
    const drawPlate = (mode: 'idle' | 'white' | 'gold'): void => {
      roundRectPath(ctx, pad, pad, W - 2 * pad, H - 2 * pad, r);
      ctx.fillStyle = mode === 'gold' ? 'rgba(216,161,58,0.94)' : mode === 'white' ? 'rgba(244,239,226,0.96)' : 'rgba(14,22,33,0.86)';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = mode === 'gold' ? 'rgba(255,236,170,0.98)' : mode === 'white' ? 'rgba(255,252,244,0.98)' : 'rgba(120,160,210,0.55)';
      ctx.stroke();
      // 文字色: 金/白の明プレートは墨文字、紺の暗プレートは淡色文字（どの層でも可読）。
      const dark = mode !== 'idle';
      ctx.textBaseline = 'middle';
      // 右: 累計失点。
      ctx.textAlign = 'right';
      ctx.font = `700 30px ${fam}`;
      const scoreW = ctx.measureText(scoreStr).width;
      ctx.fillStyle = dark ? '#3a2a06' : '#ffd873';
      ctx.fillText(scoreStr, W - pad - 12, H / 2 + 1);
      // 区切り中黒。
      ctx.fillStyle = dark ? 'rgba(32,22,3,0.6)' : 'rgba(200,214,235,0.5)';
      ctx.font = `700 26px ${fam}`;
      const sepX = W - pad - 18 - scoreW;
      ctx.fillText('·', sepX, H / 2);
      // 左: 名前（区切り手前まで省略）。
      ctx.textAlign = 'left';
      ctx.font = `700 34px ${fam}`;
      ctx.fillStyle = mode === 'gold' ? '#201603' : mode === 'white' ? '#2a2114' : '#eef3fa';
      ctx.fillText(ellipsize(ctx, name || '?', sepX - (pad + 16)), pad + 14, H / 2 + 1);
    };
    // 指定領域だけを clip してプレートを描く小ヘルパ（左端 0..edge を上書き）。
    const drawClipped = (mode: 'idle' | 'white' | 'gold', edge: number): void => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, edge, H);
      ctx.clip();
      drawPlate(mode);
      ctx.restore();
    };

    if (phase <= 0.001) {
      drawPlate('idle');
    } else if (phase >= 0.999) {
      drawPlate('gold');
    } else {
      // 二段の各進捗（easeOutCubic できびきび立ち上げる）。段1=白の先端、段2=金の先端。
      const inner = W - 2 * pad;
      const whiteP = easeOutCubic(clamp(phase * 2, 0, 1)); // 0..0.5 で 0→1
      const goldP = easeOutCubic(clamp(phase * 2 - 1, 0, 1)); // 0.5..1 で 0→1（常に <= whiteP）
      const whiteEdge = pad + inner * whiteP;
      const goldEdge = pad + inner * goldP;
      drawPlate('idle'); // 土台（紺）
      drawClipped('white', whiteEdge); // 段1: 白が先導
      if (goldP > 0.001) drawClipped('gold', goldEdge); // 段2: 金が追走
      // 現在動いている先端に細い光走査帯を置く（金が動いていれば金先端、まだ白段なら白先端）。
      const moving = goldP > 0 && goldP < 1 ? goldEdge : whiteEdge;
      const bandW = 10;
      const grad = ctx.createLinearGradient(moving - bandW, 0, moving + 2, 0);
      grad.addColorStop(0, 'rgba(255,250,236,0)');
      grad.addColorStop(1, 'rgba(255,250,236,0.95)');
      ctx.fillStyle = grad;
      ctx.fillRect(moving - bandW, pad, bandW + 2, H - 2 * pad);
    }
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
    const desired = new Map<
      string,
      { pos: THREE.Vector3; quat: THREE.Quaternion; fromDeck: boolean; delay: number; card?: Card | null }
    >();
    let dealIdx = 0;
    const reveal = this.demoHands;
    if (reveal) {
      // デモ公開モード（契約20項目2・契約22項目1で片面化）: 全席の実手札を「通常カード」で浮かべる。
      // 表(+z)＝実絵柄が持ち主側へ向き、外側（他プレイヤー/カメラ側）は裏面デザイン。カメラが持ち主側から
      // 舐めるカットで表が覗く自然な演出になり、実対局の見え方（外側は裏）とも一致する。カードごとに
      // 安定キー（h:席:cardId）で管理し、手札が変わっても正しい絵柄で作り直される（裏向きモードは
      // スロット番号キーだが、両モードは同一シーンで併用しないためキー空間は衝突しない）。
      for (const seat of view.seats) {
        const cards = reveal.get(seat.index) ?? [];
        const slots = this.floatHandLayout(seat.index, cards.length);
        // デモのツモ演出（契約21項目10）: 通常インゲームと同じ「山札→手札の飛翔」機構(fromDeck)へ統合する。
        // 席の手札が +1 枚になったフレームでは、新規に現れたカード（backById 未登録）を山札から飛ばす。
        // 席の可視トグルや公開/付け札での増減は +1 枚の条件で誤検出しない（非公開モードの isDraw と同型）。
        const prev = this.backSeatCount.get(seat.index);
        const isDraw = prev !== undefined && cards.length === prev + 1;
        cards.forEach((c, k) => {
          const s = slots[k]!;
          const key = `h:${seat.index}:${cardId(c)}`;
          // ツモ札 = 増えた1枚（既存キーには無い新規カード）。fromDeck で山札位置からの飛翔になる。
          const drawFly = isDraw && !this.backById.has(key);
          desired.set(key, {
            pos: s.pos,
            quat: s.quat, // 浮遊扇の自然な向き。表(+z)が持ち主側、裏面が外側を向く通常カード（契約22項目1）
            fromDeck: dealing || drawFly,
            delay: dealing ? dealIdx++ * DEAL_STEP_MS : 0,
            card: c,
          });
        });
        this.backSeatCount.set(seat.index, cards.length);
      }
    } else {
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
    }
    // 非表示になった席（人数減 / 自席化）の記録は破棄（次の +1 誤検出を防ぐ）。デモ公開(reveal)では
    // 自席も含め全席が浮遊表示されるため、自席除外はせず「view に居ない席」だけを破棄する（項目10）。
    for (const idx of [...this.backSeatCount.keys()]) {
      const present = reveal
        ? view.seats.some((s) => s.index === idx)
        : view.seats.some((s) => s.index === idx && idx !== view.youIndex);
      if (!present) this.backSeatCount.delete(idx);
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
        const group = this.buildCard(t.card ?? null); // デモ公開時は実絵柄（表=持ち主側）、通常は裏向き（card=null）
        const spawn = t.fromDeck ? deckPos : t.pos;
        group.position.copy(spawn);
        group.quaternion.copy(t.quat);
        group.scale.setScalar(0.5); // 出現ポップ（loop で easeOutBack）
        group.visible = false; // opacity 0 スタート（フェードイン）
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
          mats: group.userData.cardMats as THREE.Material[],
          opacity: 0,
          occluded: false,
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
    const self = seatIndex === this.viewYou; // 自分の公開か（他家起因は揺れを明確に弱める・契約19項目2）
    const p = this.seatSpot(seatIndex);
    // 発光スパーク（数・初速・寿命を増強）+ 上方へ吹き上げる金の火の粉
    this.particles.burst(p, { count: 52, color: [1, 0.85, 0.4], speed: 3.0, size: 0.13, life: 0.95 });
    this.particles.burst(p, { count: 22, color: [1, 0.95, 0.62], speed: 4.4, size: 0.08, life: 1.2, spread: 0.15, gravity: 0.6 });
    // 二重光輪（芯の速いリング + 外へ広がる余波リング）
    this.spawnRing(p, '#ffe6a0', { r1: 2.2, dur: 0.5, opacity: 1.0 });
    this.spawnRing(p, '#ffd873', { r1: 3.4, dur: 0.8, opacity: 0.7, delay: 0.09 });
    // 自分の公開はやや弱め、他家の公開は明確に控えめ（ドリー量・横揺れとも大幅に低減）。
    this.cameraPunch(self ? 0.6 : 0.22, self ? 0.8 : 0.18);
    this.wake();
  }

  /** ポン/チーの鳴き演出: 種別で色分けした大型スパーク + 二重光輪 + 強めのカメラパンチ（契約09項目2）。 */
  claimEffect(seatIndex: number, kind: 'pon' | 'chi'): void {
    const self = seatIndex === this.viewYou; // 他家の鳴きも起因が自分でなければ揺れを控えめに（契約19項目2）
    const p = this.seatSpot(seatIndex);
    const color: [number, number, number] = kind === 'pon' ? [1, 0.45, 0.3] : [0.4, 0.72, 1];
    const ringA = kind === 'pon' ? '#ff9a6a' : '#8fd0ff';
    const ringB = kind === 'pon' ? '#ff7a4d' : '#66b6ff';
    this.particles.burst(p, { count: 64, color, speed: 3.6, size: 0.14, life: 0.95, spread: 1 });
    this.particles.burst(p, { count: 24, color, speed: 5.0, size: 0.09, life: 0.7, spread: 0.2, gravity: 0.5 });
    this.spawnRing(p, ringA, { r1: 2.4, dur: 0.5, opacity: 1.0 });
    this.spawnRing(p, ringB, { r1: 3.8, dur: 0.85, opacity: 0.7, delay: 0.1 });
    this.cameraPunch(self ? 0.95 : 0.32, self ? 0.85 : 0.2);
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

  /** カメラのドリーパンチ（減衰）。reduced-motion 時はシェイクを伴わない（quality.cameraShake）。
   * shakeScale で横揺れ成分だけを個別に弱められる（他家起因の演出を控えめにする・契約19項目2）。 */
  cameraPunch(intensity: number, shakeScale = 1): void {
    if (intensity >= this.camKick) this.camShakeScale = shakeScale; // 最大パンチの倍率を採用
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
   * 首振りモデル（契約17項目7）では視点位置が自席に固定され、カメラが他家の手前へ回り込むことが
   * 原理的に無くなった。他家の空中手札（裏面）が中央のやり取りを覆う状況が生じないため、旧オービット
   * 時代の遮蔽フェード（契約14項目4）は不要化した（E5・挙動整理を報告）。念のため遮蔽状態を常に解除し、
   * すべての手札を可視のまま保つ。
   */
  private updateHandOcclusion(): void {
    if (this.blockedSeats.size) this.blockedSeats.clear();
    for (const [, obj] of this.backById) {
      if (obj.occluded) obj.occluded = false;
    }
  }

  /**
   * 既定視点（契約17項目7）: 視点位置を指定席の「着席した目線」へ置き、卓中央を見渡す既定の
   * ヨー/ピッチ/画角へ戻す。首振りモデルなので視点位置は自席に固定され、回り込みは起きない。
   * ホットシートでは youIndex が手番ごとに変わるため、目線が新しい操作者席へ移る（契約14項目3）。
   */
  private aimCameraAt(seatIndex: number): void {
    const eye = this.eyeFor(seatIndex);
    this.camPosGoal.copy(eye);
    // 既定の見回し角: 俯瞰寄りの目線から卓中央（原点）を見下ろす＝卓全体が入る構図（契約18項目2）。
    // 視点リセット・ホットシート手番リセットも aimCameraAt 経由なので同じ画角に戻る（E1）。
    const lookAt = TMP_A.set(0, 0, 0);
    const d = TMP_B.copy(lookAt).sub(eye);
    this.lookYaw = Math.atan2(d.z, d.x);
    this.lookPitch = clamp(Math.atan2(d.y, Math.hypot(d.x, d.z)), MIN_PITCH, MAX_PITCH);
    this.lookFov = this.orientationFov();
    this.camera.fov = this.lookFov;
    this.camera.updateProjectionMatrix();
    this.applyLook();
  }

  /** 指定席の着席した目線のワールド位置（自席固定の首振り視点・卓の縁越しに見渡す高さ）。 */
  private eyeFor(seatIndex: number): THREE.Vector3 {
    const dir = this.seatDir(seatIndex);
    return dir.clone().multiplyScalar(SEAT_R + EYE_BACK).setY(EYE_HEIGHT);
  }

  /** 画面の縦横に応じた既定画角（縦画面は視野が狭いので広角側）。aimCameraAt と resize で共有する。 */
  private orientationFov(): number {
    // 縦画面は横視野が狭く卓の左右が切れやすいので広角側に振る（俯瞰基点でも縦は構造的に一部見切れる）。
    return this.aspect() < 1 ? 62 : 46;
  }

  // ---- ユーザーカメラ操作（契約07項目1: ピンチズーム / スワイプ軌道回転） --------
  // 3D キャンバス上のポインタのみを扱う。手札 D&D は handEl がポインタキャプチャするため
  // ここには届かず、住み分けは自動的に成立する（手札を卓へドラッグ中はカメラを動かさない）。
  private attachCameraControls(): void {
    const el = this.renderer.domElement as HTMLElement;
    el.style.touchAction = 'none'; // ピンチでページ全体がズームしないように（E5）

    // 首振り（契約18項目1: 方向反転）: ドラッグで「画面（世界）を掴んで動かす」感覚に合わせる。
    // 指を右へ動かすと世界が右へ流れる＝視線は左を向く。指を下へ動かすと世界が下へ流れる＝視線は
    // 上を向く。従来（指の向きへ視線が追従）は直感と逆だったため、ヨー・ピッチの符号を反転する。
    // モバイルFPS/地図パンの慣習と一致。ピッチ制限（MIN/MAX_PITCH）は反転後も同じくクランプで効く（E4）。
    const lookFromDelta = (dx: number, dy: number): void => {
      this.ensureUserControl();
      this.lookYaw -= dx * LOOK_YAW_SENS;
      this.lookPitch = clamp(this.lookPitch + dy * LOOK_PITCH_SENS, MIN_PITCH, MAX_PITCH);
      this.applyLook();
    };
    // ズーム（契約17項目7）: ピンチ/ホイールで画角を増減（factor<1 で寄り＝FOV縮小）。
    const zoomBy = (factor: number): void => {
      this.ensureUserControl();
      this.lookFov = clamp(this.lookFov * factor, MIN_FOV, MAX_FOV);
      this.camera.fov = this.lookFov;
      this.camera.updateProjectionMatrix();
      this.wake();
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
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        /* 合成イベント等でアクティブポインタが無い場合のスロー無害化（デモ卓の常設で露出） */
      }
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
        // スワイプ（1本指 / マウスドラッグ）: ヨー・ピッチの首振り。
        lookFromDelta(nx - prev.x, ny - prev.y);
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
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        /* アクティブポインタ不在時のスロー無害化 */
      }
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
      this.updateLabelFacing();
      const labels: { index: number; visible: boolean; behind: boolean; ndc: number[] }[] = [];
      for (const [index, L] of this.labels) {
        const n = TMP_A.copy(L.sprite.position).project(this.camera);
        // 定常表示可否: 背面でなく表示対象（opacityTarget>0.5）。背面は投影が化けるため必ず不可視。
        const visible = !L.behind && L.opacityTarget > 0.5;
        labels.push({ index, visible, behind: L.behind, ndc: [n.x, n.y] });
      }
      return {
        pos: this.camera.position.toArray(),
        posGoal: this.camPosGoal.toArray(),
        target: this.camTargetGoal.toArray(),
        fov: this.lookFov,
        yaw: this.lookYaw,
        pitch: this.lookPitch,
        user: this.userControlled,
        labels,
      };
    };
    // 検証用（契約25）: 部屋の任意方位をカメラで見る。卓中央からyawDeg方向の壁面を注視して即スナップ。
    // 家具GLBの向き・接地・スケールの視覚検証に使う（cinematic中はstepCinematicが上書きするためゲーム内で使う）。
    (el as unknown as { __lookProbe?: (yawDeg: number, h?: number, fov?: number) => void }).__lookProbe = (
      yawDeg, h = 1.2, fov,
    ) => {
      const a = (yawDeg * Math.PI) / 180;
      this.camPosGoal.set(-Math.sin(a) * 1.5, 1.6, -Math.cos(a) * 1.5);
      this.camTargetGoal.set(Math.sin(a) * 8, h, Math.cos(a) * 8);
      this.camPos.copy(this.camPosGoal);
      this.camTarget.copy(this.camTargetGoal);
      this.camera.position.copy(this.camPos);
      this.camera.lookAt(this.camTarget);
      if (fov) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      this.wake();
    };
    // 検証用（契約29追補）: 候補地 i にテスト用パンダを強制配置し、指定画角（0=正面/1=+50°/2=-50°）で
    // 同期レンダして JPEG dataURL を返す。preserveDrawingBuffer なしでも同一タスク内の
    // renderer.render → toDataURL は有効。全候補の干渉（めり込み/浮き）敵対レビュー用。
    // i=-1 でテスト個体を撤去。通常プレイでは呼ばれない。
    (el as unknown as { __spotShot?: (i: number, ang?: number, kind?: string) => string | null }).__spotShot = (
      i, ang = 0, kind,
    ) => {
      if (this.testPlush) {
        this.scene.remove(this.testPlush);
        this.testPlush = null;
      }
      const p = HIDE_SPOTS[i];
      const src = (kind === 'dalmatian' ? this.plushSrc.dalmatian : this.plushSrc.panda) ?? this.plushSrc.dalmatian;
      if (i < 0 || !p || !src) return null;
      this.testPlush = this.placeCloneAt(p, src);
      const headY = this.testPlush.position.y + 1.05 * p.s * 0.5;
      const toCenter = Math.atan2(-p.x, -p.z) + (ang === 1 ? 0.9 : ang === 2 ? -0.9 : 0);
      const dist = 2.3;
      const cx = Math.max(-8.6, Math.min(8.6, p.x + Math.sin(toCenter) * dist));
      const cz = Math.max(-8.6, Math.min(8.6, p.z + Math.cos(toCenter) * dist));
      this.camera.position.set(cx, Math.min(headY + 0.9, 5.7), cz);
      this.camera.lookAt(p.x, headY, p.z);
      const fovKeep = this.camera.fov;
      this.camera.fov = 42;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
      const url = (this.renderer.domElement as HTMLCanvasElement).toDataURL('image/jpeg', 0.55);
      this.camera.fov = fovKeep;
      this.camera.updateProjectionMatrix();
      return url;
    };
    // 検証用（契約32）: 全候補地×両モデルの数値監査。配置後の「接地ギャップ」（底面と直下サーフェスの
    // 隙間＝浮き）と「最終身長」（クリアランス縮小・ジッター込みの実寸＝小さすぎ）を実測して返す。
    // スクリーンショット不要・決定的。gap>0.04 か height<0.29 の行が要修正。
    (el as unknown as { __spotAudit?: () => unknown }).__spotAudit = () => {
      const out: { i: number; kind: string; gap: number; height: number }[] = [];
      const ray = new THREE.Raycaster();
      for (let i = 0; i < HIDE_SPOTS.length; i++) {
        const p = HIDE_SPOTS[i]!;
        for (const kind of ['panda', 'dalmatian'] as const) {
          const src = this.plushSrc[kind];
          if (!src) continue;
          const clone = this.placeCloneAt(p, src);
          const bb = new THREE.Box3().setFromObject(clone);
          const height = bb.max.y - bb.min.y;
          let surfaceY = -0.45;
          if (this.roomGlb) {
            ray.set(new THREE.Vector3(p.x, bb.min.y + 0.02, p.z), new THREE.Vector3(0, -1, 0));
            const below = ray.intersectObject(this.roomGlb, true)[0] as { point: { y: number } } | undefined;
            if (below) surfaceY = Math.max(below.point.y, -0.45);
          }
          out.push({ i, kind, gap: +(bb.min.y - surfaceY).toFixed(3), height: +height.toFixed(3) });
          this.scene.remove(clone);
        }
      }
      return out;
    };
    // 検証用（契約34）: 候補地 i の「実際に見えるピクセル数」を6席の実カメラ位置から実測する。
    // テスト個体をマゼンタ不灯マテリアルで配置（深度は通常どおり＝本・棚板・家具の遮蔽が効く）し、
    // 各席から注視レンダ→readPixels でマゼンタ画素を数える。sMul=0.75 はジッター最小スケール相当の
    // 最悪ケース。戻り値は席ごとの可視画素数（4pxサンプリング補正済み）。
    (el as unknown as { __spotVis?: (i: number, sMul?: number) => number[] | null }).__spotVis = (
      i, sMul = 0.75,
    ) => {
      if (this.testPlush) {
        this.scene.remove(this.testPlush);
        this.testPlush = null;
      }
      const p = HIDE_SPOTS[i];
      const src = this.plushSrc.panda;
      if (i < 0 || !p || !src) return null;
      // 本ラウンドの本物の隠れ個体は監査ノイズになるため一時非表示（静的な囮・家具は実遮蔽として残す）
      const hidVis = this.hiddenPlush.map((o) => o.visible);
      for (const o of this.hiddenPlush) o.visible = false;
      this.testPlush = this.placeCloneAt({ ...p, s: Math.max(0.28, p.s * sMul) }, src);
      const mag = new THREE.MeshBasicMaterial({ color: 0xff00ff });
      this.testPlush.traverse((o: THREE.Object3D) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = mag;
      });
      const bb = new THREE.Box3().setFromObject(this.testPlush);
      const tx = (bb.min.x + bb.max.x) / 2;
      const ty2 = (bb.min.y + bb.max.y) / 2;
      const tz = (bb.min.z + bb.max.z) / 2;
      const gl = this.renderer.getContext() as WebGLRenderingContext;
      const w = (this.renderer.domElement as HTMLCanvasElement).width;
      const h = (this.renderer.domElement as HTMLCanvasElement).height;
      const buf = new Uint8Array(w * h * 4);
      const counts: number[] = [];
      const fovKeep = this.camera.fov;
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        this.camera.position.set(Math.sin(a) * 6.1, 2.73, Math.cos(a) * 6.1);
        this.camera.lookAt(tx, ty2, tz);
        this.camera.fov = 40;
        this.camera.updateProjectionMatrix();
        this.renderer.render(this.scene, this.camera);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let c = 0;
        for (let q = 0; q < buf.length; q += 16) {
          if (buf[q]! > 200 && buf[q + 1]! < 80 && buf[q + 2]! > 200) c++;
        }
        counts.push(c * 4);
      }
      this.camera.fov = fovKeep;
      this.camera.updateProjectionMatrix();
      mag.dispose();
      this.hiddenPlush.forEach((o, k) => (o.visible = hidVis[k] ?? true));
      return counts;
    };
    // 検証用（契約26）: かくれんぼの現在配置（[パンダ, ダルメシアン] の順・ワールド座標とスケール）。
    (el as unknown as { __hiddenProbe?: () => unknown }).__hiddenProbe = () =>
      this.hiddenPlush.map((o) => ({
        pos: [o.position.x, o.position.y, o.position.z].map((v) => +v.toFixed(2)),
        scale: +o.scale.x.toFixed(3),
      }));
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
    // 検証用（契約24）: ぬいぐるみリアクションの注視+ズーム検知を DOM/JS で駆動・観測する。
    // 'state'=現状態、'stare'=個体頭部を寄って見つめる（fov指定）、'away'=既定俯瞰へ視線を外す。
    // カメラの camPos/camPosGoal/camTarget/fov を直接据えて（userControlled で自動再照準を抑止し）
    // ループを起こす＝注視が実際に成立し、デバウンス/クールダウン/演出→復帰が実機同様に進む。
    (el as unknown as { __plushProbe?: (cmd: string, kind?: string, fov?: number) => unknown }).__plushProbe = (cmd, kind, fov) => {
      const pr = this.plushReactions;
      if (!pr) return { ready: false };
      if (cmd === 'state') return pr.debugState();
      if (cmd === 'stare') {
        const head = pr.debugHead((kind ?? 'dalmatian') as 'dalmatian' | 'panda');
        if (!head) return { ok: false, reason: 'not-registered' };
        this.userControlled = true;
        const eye = TMP_A.set(head.x + 4.0, head.y + 0.2, head.z); // ソファ手前（+X＝部屋中央側）から寄る
        this.camPosGoal.copy(eye);
        this.camPos.copy(eye);
        this.camTargetGoal.copy(head);
        this.camTarget.copy(head);
        this.lookFov = fov ?? 34;
        this.camera.fov = this.lookFov;
        this.camera.position.copy(eye);
        this.camera.lookAt(head);
        this.camera.updateProjectionMatrix();
        this.wake();
        return { ok: true, eye: (eye.toArray() as number[]).map((n) => +n.toFixed(2)), fov: this.lookFov };
      }
      if (cmd === 'away') {
        this.userControlled = true;
        const eye = TMP_A.set(0, 4, 6);
        this.camPosGoal.copy(eye);
        this.camPos.copy(eye);
        this.camTargetGoal.set(0, 0, 0);
        this.camTarget.set(0, 0, 0);
        this.lookFov = 46;
        this.camera.fov = 46;
        this.camera.position.copy(eye);
        this.camera.lookAt(this.camTarget);
        this.camera.updateProjectionMatrix();
        this.wake();
        return { ok: true };
      }
      return { ok: false, reason: 'unknown-cmd' };
    };
    // 計測用（契約20項目4）: 静的家具の1メッシュ統合による描画コール削減の before/after を測る。
    // 呼び出し時にシーンを1回強制描画してから renderer.info.render を読む（hidden ペインで rAF が
    // 止まっていても確定値が取れる）。postfx を経ないシーン素描画のコール数＝統合効果が素直に出る。
    (el as unknown as { __renderStats?: () => unknown }).__renderStats = () => {
      this.renderer.render(this.scene, this.camera);
      const r = this.renderer.info.render;
      return { calls: r.calls, triangles: r.triangles, merged: MERGE_FURNITURE };
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

  /** 初回のユーザー操作で、現在の見た目の視線方向から首振り角を取り込む（滑らかな引き継ぎ）。 */
  private ensureUserControl(): void {
    if (this.userControlled) return;
    this.userControlled = true;
    // 現在の視点位置を目線として固定し、現在の視線方向からヨー/ピッチを起こす。
    this.camPosGoal.copy(this.camPos);
    const off = TMP_A.subVectors(this.camTarget, this.camPos);
    if (off.lengthSq() > 1e-6) {
      this.lookYaw = Math.atan2(off.z, off.x);
      this.lookPitch = clamp(Math.atan2(off.y, Math.hypot(off.x, off.z)), MIN_PITCH, MAX_PITCH);
    }
    this.lookFov = this.camera.fov;
  }

  /** 首振り角（ヨー/ピッチ）から注視点目標を更新する。視点位置は camPosGol 固定。loop が滑らかに追従する。 */
  private applyLook(): void {
    const cosP = Math.cos(this.lookPitch);
    const fx = cosP * Math.cos(this.lookYaw);
    const fy = Math.sin(this.lookPitch);
    const fz = cosP * Math.sin(this.lookYaw);
    // 注視点 = 目線位置 + 前方単位ベクトル（lookAt は方向のみ使うので距離は 1 で十分）。
    this.camTargetGoal.set(this.camPosGoal.x + fx, this.camPosGoal.y + fy, this.camPosGoal.z + fz);
    this.wake();
  }

  /** 自席の既定視点へ戻す（HUDのリセットボタンから呼ぶ・契約17項目7）。 */
  resetView(): void {
    this.userControlled = false;
    this.pointers.clear();
    this.pinchDist = 0;
    this.aimCameraAt(this.viewYou);
    this.wake();
  }

  // ---- 描画ループ ---------------------------------------------------------

  private loop = (): void => {
    const rawDt = this.clock.getDelta();
    // シネマ（タイトルデモ）は約32fpsへ間引く（契約19項目3: 発熱/負荷対策。背景なので体感差ほぼ無し）。
    // clock.getDelta() は毎フレーム1回だけ呼ぶ（複数回呼ぶと2回目以降が~0になる）ため、間引き分は
    // アキュムレータに溜めて描画フレームでまとめて dt に使う＝イージングは滑らかなまま。
    if (this.cinematic) {
      this.cineFrameAccum += rawDt;
      if (this.cineFrameAccum < CINE_FRAME_MIN) {
        this.raf = requestAnimationFrame(this.loop);
        return;
      }
    }
    const dt = Math.min(this.cinematic ? this.cineFrameAccum : rawDt, 0.05);
    if (this.cinematic) this.cineFrameAccum = 0;
    const k = 1 - Math.exp(-EASE_SPEED * dt);
    const now = performance.now();
    let motion = 0; // 残り移動量の指標（settle 判定用）
    let busy = false; // 退場アニメ等で継続が必要か
    let fxBusy = false; // 粒子/光輪/カメラパンチ等の演出が継続中か

    // タイトル背景のデモ対局: 複数カットを黒フェードで切り替えるシネマ演出（契約19項目5）。idle させない。
    if (this.cinematic) {
      this.stepCinematic(dt);
      fxBusy = true;
    }

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
        const sh = this.camKick * 0.14 * this.camShakeScale;
        this.camera.position.x += (Math.random() - 0.5) * sh;
        this.camera.position.y += (Math.random() - 0.5) * sh;
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

    // 席名ラベルの前後判定（カメラのイージングに追従・背面は隠す・項目3）+ 不透明度クロスフェード（Q8）
    this.updateLabelFacing();
    if (this.stepLabelFades(k, dt)) fxBusy = true;
    // カメラが手前に回り込んだ他家の空中手札を隠す（契約14項目4）。カメラのイージングに毎フレーム追従。
    this.updateHandOcclusion();

    // 既知カード（面）・裏カードともに統一機構で補間（出現/退場/遮蔽フェード + バネ出現・Q5/Q6/Q12/U3）
    for (const [id, obj] of this.known) {
      motion += obj.group.position.distanceTo(obj.targetPos);
      const r = this.animateCard(obj, now, k);
      if (r.busy) busy = true;
      if (r.done) {
        this.scene.remove(obj.group);
        this.disposeCardMats(obj);
        this.known.delete(id);
      }
    }
    for (const [id, obj] of this.backById) {
      motion += obj.group.position.distanceTo(obj.targetPos);
      const r = this.animateCard(obj, now, k);
      if (r.busy) busy = true;
      if (r.done) {
        this.scene.remove(obj.group);
        this.disposeCardMats(obj);
        this.backById.delete(id);
      }
    }

    // ラウンド遷移の旧札掃引退場（Q1）: フェードしながら卓外・下方へ払われる。配札（新カード）と重なって
    // クロスフェードになる。SWEEP_MS で消える。
    for (let i = this.sweeping.length - 1; i >= 0; i--) {
      const sw = this.sweeping[i]!;
      const u = (now - sw.born) / SWEEP_MS;
      if (u >= 1) {
        this.scene.remove(sw.group);
        for (const m of sw.mats) m.dispose();
        this.sweeping.splice(i, 1);
        continue;
      }
      const e = u * u * (3 - 2 * u); // smoothstep
      sw.group.position.lerp(sw.to, Math.min(1, k));
      sw.group.scale.setScalar(Math.max(0.02, 1 - e));
      for (const m of sw.mats) (m as THREE.Material & { opacity: number }).opacity = 1 - e;
      busy = true;
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

    // ぬいぐるみ「見つめると反応する」リアクション（契約24）: 注視+ズーム検知→両体の transform 演出。
    // busy（デバウンス中/演出中）は idle 停止を抑止する。1.5秒の意図的な注視＋ズームでのみ発火する
    // ユーザー起点の演出のため、prefers-reduced-motion でも抑制しない（Windows の「アニメーション効果」
    // OFF で reduce が立つ環境ではハートが一切出ず「出ない」と見える不具合になっていた）。
    if (this.plushReactions?.update(dt, this.camera, this.camTarget, this.cinematic, false)) {
      fxBusy = true;
    }

    // 手番の光だまり（契約17項目2）: spotTarget（現手番席の前）に追従し、ゆるく脈動する金色の床グロー
    // ＋細い金環。自席の手番ではほぼ非表示まで落とす（自分の番は 2D 手札・手番バナーで示す）。
    // 表示/非表示はフェードで切替え、手番交代で「白い円」がパッと出入りしないようにする。
    {
      this.spotGlow.position.set(this.spotTarget.x, TABLE_TOP_Y + 0.021, this.spotTarget.z);
      this.spotRing.position.set(this.spotTarget.x, TABLE_TOP_Y + 0.022, this.spotTarget.z);
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.0024);
      const targetOp = this.activeSeatSelf ? 0.05 : 0.26 + 0.08 * pulse;
      const ko = Math.min(1, k * 1.2);
      if (Math.abs(this.spotGlowOp - targetOp) > 0.002) {
        this.spotGlowOp += (targetOp - this.spotGlowOp) * ko;
        fxBusy = true;
      } else {
        this.spotGlowOp = targetOp;
      }
      (this.spotGlow.material as THREE.MeshBasicMaterial).opacity = this.spotGlowOp;
      // 金環は光だまりより控えめ＆自席ではほぼ消す。輪郭のパルスで手番マーカーだと分かる。
      (this.spotRing.material as THREE.MeshBasicMaterial).opacity = this.activeSeatSelf
        ? this.spotGlowOp * 0.4
        : (0.4 + 0.25 * pulse) * Math.min(1, this.spotGlowOp / 0.26);
      const ringScale = 1 + 0.05 * pulse;
      this.spotRing.scale.setScalar(ringScale);
    }

    // 鳴きウィンドウ開始のハイライト（Q11）: 対象の捨て札上で脈動するリング。
    if (this.claimFocusActive) {
      const cm = this.claimRing.material as THREE.MeshBasicMaterial;
      cm.opacity = 0.5 + 0.35 * (0.5 + 0.5 * Math.sin(now * 0.008));
      this.claimRing.scale.setScalar(1 + 0.06 * Math.sin(now * 0.008));
      fxBusy = true;
    }

    // 3D ドロップ標的の脈動（ドラッグ中のみ・ホバー標的は強調）
    if (this.dropActive) {
      const puls = 0.34 + 0.22 * (0.5 + 0.5 * Math.sin(now * 0.005));
      for (const r of this.dropRings) {
        const mat = r.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = r.hot ? 0.95 : puls;
        r.mesh.scale.setScalar(r.hot ? 1.16 : 1.0);
      }
      fxBusy = true;
    } else if (this.dropHiding) {
      // ドロップ終了: 即消しでなく短くフェードアウトしてから片付ける（Q15）。
      const u = (now - this.dropHideAt) / 220;
      const f = Math.max(0, 1 - u);
      for (const r of this.dropRings) (r.mesh.material as THREE.MeshBasicMaterial).opacity = f * 0.9;
      if (u >= 1) this.finishHideDropTargets();
      else fxBusy = true;
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
    let dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    if (this.cinematic) dpr = Math.min(dpr, CINE_DPR_CAP); // 背景デモは低DPRで十分（契約19項目3）
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.camera.aspect = this.aspect();
    // 縦横切替（回転）に追従して画角を更新する（E7）。未操作なら既定画角へ、ユーザーがズーム中は
    // その画角を保持したまま範囲だけ再クランプする。首振りの視点位置・向きは保持する。
    if (!this.userControlled) this.lookFov = this.orientationFov();
    else this.lookFov = clamp(this.lookFov, MIN_FOV, MAX_FOV);
    this.camera.fov = this.lookFov;
    this.camera.updateProjectionMatrix();
    this.postfx?.setSize(w, h, this.renderer.getPixelRatio());
    this.particles.setScale(this.particleScale());
    this.wake();
  }

  /** ラウンド切り替え等でカードを全消去（次の update で再構築＝配札スタッガ演出）。 */
  clearCards(): void {
    // 旧札はハードカットで消さず、掃引退場リストへ移して配札とクロスフェードさせる（Q1）。
    const now = performance.now();
    const sweep = (obj: CardObj): void => {
      // 掃引が溜まりすぎたら即破棄（連続 clearCards の暴走防止）。
      if (this.sweeping.length > 120) {
        this.scene.remove(obj.group);
        this.disposeCardMats(obj);
        return;
      }
      const to = obj.group.position.clone();
      const h = TMP_A.set(to.x, 0, to.z);
      if (h.lengthSq() > 1e-4) to.addScaledVector(h.normalize(), 0.7);
      to.y -= 0.7;
      this.sweeping.push({ group: obj.group, mats: obj.mats, born: now, to });
    };
    for (const [, obj] of this.known) sweep(obj);
    this.known.clear();
    for (const [, obj] of this.backById) sweep(obj);
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
    this.cineFadeEl?.remove(); // シネマ黒フェード幕（契約19項目5）
    this.cineFadeEl = null;
    delete (cel as unknown as { __cameraState?: () => unknown }).__cameraState;

    // 演出資源（コンテキストロスト対策・E11）: 光輪 → パーティクル → コンポーザ → 環境マップ
    for (const r of this.rings) {
      this.scene.remove(r.mesh);
      (r.mesh.material as { dispose?: () => void }).dispose?.();
    }
    this.rings.length = 0;
    this.sweeping.length = 0; // 掃引中の旧札（materials/geometry は下の traverse が解放）
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
    disposePlushTextures(); // ぬいぐるみの斑点 Canvas テクスチャ（map は traverse では解放されない・E3）
    this.plushReactions?.dispose(); // wave GLB / ミキサー / 状態を解放（契約24・E3/E5）
    this.plushReactions = null;
    // Meshy GLB のジオメトリ・マテリアル・テクスチャを明示解放（契約24）
    for (const obj of this.plushGlbs) {
      obj.traverse((o: THREE.Object3D) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const sm = m as THREE.MeshStandardMaterial;
            sm.map?.dispose?.();
            sm.dispose?.();
          }
        }
      });
      this.scene.remove(obj);
    }
    this.plushGlbs = [];
    // 統合家具 GLB（契約25）: ジオメトリ・マテリアル・アトラステクスチャを明示解放
    if (this.roomGlb) {
      this.roomGlb.traverse((o: THREE.Object3D) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            const sm = m as THREE.MeshStandardMaterial;
            sm.map?.dispose?.();
            sm.dispose?.();
          }
        }
      });
      this.scene.remove(this.roomGlb);
      this.roomGlb = null;
    }
    // かくれんぼのクローン（契約26）: 資源はクローン元（plushGlbs）と共有のため remove のみ
    for (const o of this.hiddenPlush) this.scene.remove(o);
    this.hiddenPlush = [];
    this.plushSrc = {};
    // 躯体/ラグの Canvas テクスチャとラグメッシュ（契約27・E3）
    for (const t of this.roomTextures) t.dispose?.();
    this.roomTextures = [];
    if (this.rugMesh) {
      this.rugMesh.geometry?.dispose?.();
      (this.rugMesh.material as THREE.Material).dispose?.();
      this.scene.remove(this.rugMesh);
      this.rugMesh = null;
    }
    for (const m of this.zoneDecor) {
      m.geometry?.dispose?.();
      (m.material as THREE.Material).dispose?.();
      this.scene.remove(m);
    }
    this.zoneDecor = [];
    // GLB 未ロードのまま破棄される場合に備え、swap 家具（クローンマテリアル）も明示解放（契約25）
    for (const mesh of this.swapFurniture) {
      mesh.geometry?.dispose?.();
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) m.dispose?.();
      this.scene.remove(mesh);
    }
    this.swapFurniture = [];

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
const TMP_B = new THREE.Vector3(); // 補間・投影の一時ベクトル
const TMP_R = new THREE.Vector3(); // updateLabelFacing のカメラ視線前方ベクトル（背面判定軸）
const TMP_HIT = new THREE.Vector3(); // dropTargetAt の交点用（ポインタ処理とループは同時実行されない）

/** 値を [lo, hi] に丸める（オービットのズーム/仰角クランプ用）。 */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** きびきびした立ち上がり（手番ワイプ二段の各段に使用・契約22項目3）。t:0→1 で 0→1・終端で減速。 */
function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** バネ状のオーバーシュート（決めアクションの出現に躍動を与える・Q12）。t:0→1 で 0→1（途中で >1）。 */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
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
