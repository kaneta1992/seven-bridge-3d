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

const CARD_W = 0.72;
const CARD_H = 1.0;
const CARD_D = 0.02;
const TABLE_TOP_Y = 0;
const SEAT_R = 2.55; // 席の半径
const HAND_SPACING = 0.52;
const EASE_SPEED = 7.5; // 補間の速さ（大きいほど機敏）

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

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';
    setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a1018');
    this.scene.fog = new THREE.Fog('#0a1018', 9, 20);

    this.camera = new THREE.PerspectiveCamera(45, this.aspect(), 0.1, 100);
    this.camera.position.copy(this.camPos);

    this.bodyGeo = new RoundedBoxGeometry(CARD_W, CARD_H, CARD_D, 4, 0.06);
    this.planeGeo = new THREE.PlaneGeometry(CARD_W * 0.98, CARD_H * 0.98);
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: '#f2efe6',
      roughness: 0.55,
      metalness: 0.0,
      // 本体を深度方向へ僅かに後退させ、面テクスチャ平面が常に手前で描画される（Z-fighting 対策）
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.backMat = new THREE.MeshStandardMaterial({ map: backTexture(), roughness: 0.5, metalness: 0.05 });

    this.buildEnvironment();
    this.wake();
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
    // 環境光・半球光・キーライト（影）・スポット（ドラマ）
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x24301f, 0.5));

    const key = new THREE.DirectionalLight(0xfff4e0, 1.3);
    key.position.set(3.5, 8, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 25;
    const d = 7;
    key.shadow.camera.left = -d;
    key.shadow.camera.right = d;
    key.shadow.camera.top = d;
    key.shadow.camera.bottom = -d;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const spot = new THREE.SpotLight(0xffffff, 40, 20, Math.PI / 5, 0.6, 1.4);
    spot.position.set(0, 9, 0.5);
    spot.target.position.set(0, 0, 0);
    this.scene.add(spot);
    this.scene.add(spot.target);

    // 卓（フェルト天板 + 木縁）
    const feltMat = new THREE.MeshStandardMaterial({ map: feltTexture(), roughness: 0.9, metalness: 0.0 });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 0.3, 72), feltMat);
    top.position.y = TABLE_TOP_Y - 0.15;
    top.receiveShadow = true;
    this.scene.add(top);

    const rimMat = new THREE.MeshStandardMaterial({ color: '#5a3a21', roughness: 0.6, metalness: 0.15 });
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
      m = new THREE.MeshStandardMaterial({ map: faceTexture(card), roughness: 0.5, metalness: 0.02 });
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
    this.syncBackPool(backTargets, now);

    // カメラを現手番（=youIndex）席の背後へ演出移動
    this.aimCameraAt(view.youIndex);
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
          obj.group.position.copy(targets[i]!.pos);
          obj.group.quaternion.copy(targets[i]!.quat);
        }
        obj.targetPos.copy(targets[i]!.pos);
        obj.targetQuat.copy(targets[i]!.quat);
      } else {
        obj.group.visible = false;
      }
    });
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

    // カメラ補間
    motion += this.camPos.distanceTo(this.camPosGoal) + this.camTarget.distanceTo(this.camTargetGoal);
    this.camPos.lerp(this.camPosGoal, k * 0.6);
    this.camTarget.lerp(this.camTargetGoal, k * 0.6);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    // 既知カード補間 + 退場処理
    for (const [id, obj] of this.known) {
      if (now - obj.born >= obj.delay) {
        obj.spawned = true;
        motion += obj.group.position.distanceTo(obj.targetPos);
        obj.group.position.lerp(obj.targetPos, k);
        obj.group.quaternion.slerp(obj.targetQuat, k);
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
    // 裏カード補間
    for (const obj of this.backPool) {
      if (!obj.group.visible) continue;
      motion += obj.group.position.distanceTo(obj.targetPos);
      obj.group.position.lerp(obj.targetPos, k);
      obj.group.quaternion.slerp(obj.targetQuat, k);
    }

    this.renderer.render(this.scene, this.camera);

    // settle したら次ラウンド/操作まで RAF を停止（省電力・E5 / スクショ可能化）
    if (motion < 0.004 && !busy) this.idle++;
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h);
    this.camera.aspect = this.aspect();
    this.camera.updateProjectionMatrix();
    this.wake();
  }

  /** ラウンド切り替え等でカードを全消去（次の update で再構築）。 */
  clearCards(): void {
    for (const [, obj] of this.known) this.scene.remove(obj.group);
    this.known.clear();
    for (const obj of this.backPool) obj.group.visible = false;
    this.wake();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.running = false;

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

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return h;
}
