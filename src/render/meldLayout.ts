// メルド配置の純粋幾何ロジック（DOM/three 非依存・契約11）。
//
// 目的: 公開メルドがいくつ増えても、卓中央の山札/捨て札ゾーンや隣席のメルド領域と
// 視覚的に重ならないように、各席の「セクタ（扇形）」内へメルドカードを配置する。
// 3D 依存を持たないので、極端ケース（6人×3メルド / 1人17メルド / 13枚シークエンス）を
// 数値でテストできる（ペイン非表示でスクショ不可なため・SKILL の幾何検証方針）。
//
// 座標系: 席のローカル 2D 平面。u = 半径方向（中心=0、席側=正）、v = 接線方向（席正面=0）。
// scene.ts が u,v を dir/tangent へ写像し、scale を各カード group に適用する。
//
// 配置方針:
//  - 行は「外周（席側 = row0）→ 中心方向」へ折り返す。最内行の中心を rc+halfH で床止めするため、
//    中央保護ゾーン（半径 rc）へは絶対に侵入しない（要件1）。
//  - 各カードの隅を席の角度セクタ（±(π/n)）内へ収める tan 制約で隣席と不可侵（要件2）。
//  - 収まらなければカードスケールを段階的に縮小（要件3）。
//  - カードレベルの flow で長いメルド（最長13枚）は行を跨いで折り返す＝極小スケール化を回避（要件6）。
//  - メルド間ギャップ・段間ギャップを常に正に保つ（要件4）。

export const CARD_W = 0.72;
export const CARD_H = 1.0;

// --- レイアウト定数（scale=1 基準。スケール時はこれらに scale を乗じる） ---
const STEP = 0.34; // メルド内カードの接線間隔（適度な重なり）
const MELD_GAP = 0.3; // メルド間の接線ギャップ（>0 を保証: 要件4）
const ROW_GAP = 0.16; // 段間の半径ギャップ（>0 を保証: 要件4 「段間の重なり」解消）
const R_RIM_EDGE = 3.3; // 最外行カードの外縁半径の上限（卓半径3.5内・必要な段数だけ外周へ伸ばす）
// 中央保護半径 rc。山札(0.5,0)/捨て札(-0.5,0)は x 軸上に偏在するため、席方向の x 成分が
// 大きい（山札/捨て札を向く）席ほど保護半径を広げる。z 方向の席は中央の張り出しが小さいので
// 保護半径を詰めて可読なカードサイズを確保する（要件1と3の両立）。
const R_CENTER_BASE = 0.9;
const R_CENTER_BULGE = 0.45;
const ANGLE_MARGIN = 0.1; // セクタ境界からの角度マージン（rad）
const V_CAP = 2.5; // 接線方向 half-width の上限（少人数=広いセクタでの暴走を抑制）

const SCALE_MAX = 1.0;
const SCALE_MIN = 0.42; // 可読下限（R8で拡大した文字が効く範囲）
const SCALE_STEP = 0.06;

export interface MeldInput {
  id: number;
  count: number; // メルドのカード枚数
}

export interface CardSlot {
  meldId: number;
  index: number; // メルド内のカード順（orderedMeldCards の並び）
  u: number; // 半径方向（中心からの距離）
  v: number; // 接線方向（席正面=0）
}

export interface MeldLayout {
  scale: number;
  slots: CardSlot[];
  overflow: boolean; // 最小スケールでも収まらず中央/セクタ外へはみ出した（エスカレーション指標）
}

/** 席方向の x 成分から中央保護半径を返す（山札/捨て札の x 軸偏在を考慮）。 */
export function centerKeepout(dirX: number): number {
  return R_CENTER_BASE + R_CENTER_BULGE * Math.abs(dirX);
}

/** 席の角度セクタ半幅（境界マージン込み）。人数が少ないほど広い。 */
function sectorHalfAngle(seatCount: number): number {
  return Math.min(1.3, Math.max(0.3, Math.PI / seatCount - ANGLE_MARGIN));
}

interface Cell {
  meldId: number;
  index: number;
  meldStart: boolean; // メルドの先頭カード（前にメルド間ギャップを入れる）
}

/**
 * 1席分のメルドカードをローカル u,v へ配置する。収まる最大スケールを段階探索で選ぶ。
 * どのスケールでも収まらない場合は最小スケールで中央方向へ溢れさせ overflow=true を返す
 * （カードは決して落とさない）。
 */
export function layoutSeatMelds(
  seatCount: number,
  dirX: number,
  melds: MeldInput[],
  selfSeat = false,
): MeldLayout {
  const cells: Cell[] = [];
  for (const m of melds) {
    const cnt = Math.max(1, m.count);
    for (let i = 0; i < cnt; i++) cells.push({ meldId: m.id, index: i, meldStart: i === 0 });
  }
  if (cells.length === 0) return { scale: SCALE_MAX, slots: [], overflow: false };

  // 中央保護（山札/捨て札の非被覆）は自席でも不可侵に保つ＝rc は共通（契約12: 中央保護維持）。
  const rc = centerKeepout(dirX);
  const sectorHalf = sectorHalfAngle(seatCount);

  // 段数の探索順。自席は「段数を最小化 → その段数で最大スケール」の順に探す＝メルドを最内帯へ
  // 集め、外周（画面下＝手札帯側）へ段を伸ばさない（項目1a）。段は画面下方向へ投影されるため、
  // 段を減らすほどメルドが手札帯より上に集まり付け札しやすい。スケール縮小で段数を優先的に抑える。
  // 段が減らせないケースは順に段数を緩め、最終的に従来と同じ無制限段へ落ちる。
  // 他席は従来どおり段数無制限（最大スケール優先）。
  const rowCaps = selfSeat ? [1, 2, 3, 4, 5, 6, 7, 8, Infinity] : [Infinity];
  for (const cap of rowCaps) {
    for (let s = SCALE_MAX; s >= SCALE_MIN - 1e-9; s -= SCALE_STEP) {
      const slots = flow(cells, s, rc, sectorHalf, false, cap);
      if (slots) return { scale: round2(s), slots, overflow: false };
    }
  }
  // 最小スケールでも収まらない（病的ケース: 極小セクタに超多数メルド）。溢れを許容し報告する。
  const slots = flow(cells, SCALE_MIN, rc, sectorHalf, true, Infinity)!;
  return { scale: SCALE_MIN, slots, overflow: true };
}

/**
 * カードを「中心側 row0 → 外周」へ行単位で flow する。最内行を中央保護の床(rc+halfH)に置くため、
 * 中央ゾーンへは構造的に侵入しない。段が増えるぶんは卓の外周方向（rim まで room がある）へ伸ばす。
 * force=false のとき、行数超過（rim 超え）・単カード幅超過があれば null（＝要縮小）。
 * force=true では rim を越えてでも全カードを置く（中央は依然侵さない・エスカレーション指標）。
 */
function flow(
  cells: Cell[],
  s: number,
  rc: number,
  sectorHalf: number,
  force: boolean,
  rowCap = Infinity,
): CardSlot[] | null {
  const w = CARD_W * s;
  const step = STEP * s;
  const gap = MELD_GAP * s;
  const halfH = (CARD_H * s) / 2;
  const rowPitch = CARD_H * s + ROW_GAP * s; // 段間ピッチ（>h なので段間ギャップ>0）
  const bandLo = rc + halfH; // 最内行の中心半径（中央保護の床）
  const bandHi = R_RIM_EDGE - halfH; // 最外行の中心半径の上限（rim）
  if (bandHi < bandLo && !force) return null; // 席がカード1枚ぶんの帯すら確保できない → 縮小
  // 物理的に置ける最大段数。rowCap（自席の段数上限プリファレンス）で更に絞る（項目1a）。
  const physMaxRows = Math.max(1, Math.floor((bandHi - bandLo) / rowPitch) + 1);
  const maxRows = force ? physMaxRows : Math.min(physMaxRows, rowCap);

  const slots: CardSlot[] = [];
  const tanS = Math.tan(sectorHalf);
  let i = 0;
  let row = 0;
  while (i < cells.length) {
    if (row >= maxRows && !force) return null;
    // 行の中心半径。row0 が最内（中央保護の床）、外周へ向かって積む。
    const u = bandLo + row * rowPitch;
    const innerR = Math.max(0.05, u - halfH); // 行の最内半径（角度が最も開く隅）
    const vHalf = Math.min(V_CAP, innerR * tanS);
    const budget = 2 * vHalf; // 行の接線方向に使える全幅

    // この行に載るカード数を貪欲に決める（中心座標 pos を積算、全幅 = 最終pos + w）。
    // メルド境界の中心間隔は w+gap（＝カード外縁どうしが gap 分離れる: 要件4 の正ギャップ保証）。
    // メルド内は step（<w なので適度に重なる扇状表示）。
    let take = 0;
    let pos = 0;
    while (i + take < cells.length) {
      const cell = cells[i + take]!;
      const advance = take === 0 ? 0 : cell.meldStart ? w + gap : step;
      const cand = pos + advance;
      const fullWidth = cand + w;
      if (take > 0 && fullWidth > budget + 1e-9) break; // 次のカードで溢れる
      pos = cand;
      take++;
      if (take === 1 && fullWidth > budget + 1e-9) {
        // 1枚ですらセクタ幅に収まらない
        if (!force) return null;
        break; // force: はみ出しを許容して1枚だけ置く
      }
    }
    if (take === 0) {
      if (!force) return null;
      take = 1; // 保険（通常到達しない）
    }

    // 行内カードの中心 pos を確定して中央寄せ（v = -span/2 .. +span/2）。
    const positions: number[] = [];
    let p = 0;
    for (let k = 0; k < take; k++) {
      const cell = cells[i + k]!;
      if (k > 0) p += cell.meldStart ? w + gap : step;
      positions.push(p);
    }
    const span = positions[positions.length - 1]!; // 最終カードの中心位置（全幅 = span + w）
    const offset = -span / 2;
    for (let k = 0; k < take; k++) {
      const cell = cells[i + k]!;
      slots.push({ meldId: cell.meldId, index: cell.index, u, v: offset + positions[k]! });
    }
    i += take;
    row++;
  }
  return slots;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
