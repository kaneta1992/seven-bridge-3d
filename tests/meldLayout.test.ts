// メルド配置（render/meldLayout の layoutSeatMelds）の幾何検証（契約11）。
// ペイン非表示でスクショ不可のため、純粋関数を極端ケースで数値検証する（SKILL の幾何検証方針）。
// 検証項目: ①中央保護ゾーン非侵入 ②席角セクタ内（隣席不可侵） ③メルド間ギャップ>0 / 段間ギャップ>0。
import { describe, expect, it } from 'vitest';
import { CARD_H, CARD_W, layoutSeatMelds, type MeldInput } from '../src/render/meldLayout';

// scene.ts と一致する席ジオメトリ。
const seatAngle = (i: number, n: number): number => Math.PI / 2 + (i * 2 * Math.PI) / n;
const seatDir = (i: number, n: number): { x: number; z: number } => {
  const a = seatAngle(i, n);
  return { x: Math.cos(a), z: Math.sin(a) };
};

// 中央の山札(0.5,0)/捨て札(-0.5,0)。カードはローカル u(半径)/v(接線) の軸に整列した平置き矩形。
const DECK = { x: 0.5, z: 0 };
const DISCARD = { x: -0.5, z: 0 };
// 山札/捨て札のカード footprint は中心から最大 ~0.75（平置きカードの半対角+捨て札ジッタ）。
// メルドカードがこの距離以内に入らなければ、山札/捨て札の絵柄と重ならない（要件1）。
const PILE_CLEAR = 0.75;
const ORIGIN_KEEP = 0.8; // 中央（原点）保護ゾーン半径の下限（要件1「半径 r_center 程度」）

interface Placed {
  meldId: number;
  index: number;
  u: number;
  v: number;
  halfH: number; // 半径方向の半サイズ
  halfW: number; // 接線方向の半サイズ
  dir: { x: number; z: number };
  tan: { x: number; z: number };
}

function place(seatCount: number, seatIndex: number, melds: MeldInput[], selfSeat = false) {
  const dir = seatDir(seatIndex, seatCount);
  const tan = { x: -dir.z, z: dir.x };
  const res = layoutSeatMelds(seatCount, dir.x, melds, selfSeat);
  const halfH = (CARD_H * res.scale) / 2;
  const halfW = (CARD_W * res.scale) / 2;
  const placed: Placed[] = res.slots.map((sl) => ({
    meldId: sl.meldId,
    index: sl.index,
    u: sl.u,
    v: sl.v,
    halfH,
    halfW,
    dir,
    tan,
  }));
  return { res, placed };
}

// 点(px,pz)から、カード矩形（ローカル軸整列）への最短距離。
function distToCard(px: number, pz: number, c: Placed): number {
  const tu = px * c.dir.x + pz * c.dir.z; // 点の半径方向座標
  const tv = px * c.tan.x + pz * c.tan.z; // 点の接線方向座標
  const du = Math.max(0, Math.abs(tu - c.u) - c.halfH);
  const dv = Math.max(0, Math.abs(tv - c.v) - c.halfW);
  return Math.hypot(du, dv);
}

// カードの4隅の、席中心線からの最大角度偏差。
function maxCornerAngle(c: Placed): number {
  let m = 0;
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const cu = c.u + su * c.halfH;
      const cv = c.v + sv * c.halfW;
      m = Math.max(m, Math.abs(Math.atan2(cv, cu)));
    }
  }
  return m;
}

// あるカードの原点からの最短距離。
function distToOrigin(c: Placed): number {
  const du = Math.max(0, c.u - c.halfH); // u>halfH 前提（中央保護で担保）
  const dv = Math.max(0, Math.abs(c.v) - c.halfW);
  return Math.hypot(du, dv);
}

interface Metrics {
  minPileClear: number; // 全カードの山札/捨て札への最短距離の最小
  minOriginClear: number; // 原点への最短距離の最小
  maxSectorFrac: number; // (最大角度偏差 / セクタ半幅 π/n) の最大。<1 なら隣席不可侵
  minMeldGap: number; // 同一行・異メルド隣接カードの接線ギャップの最小（>0 必須）
  minRowGap: number; // 隣接段の半径ギャップの最小（>0 必須。行が1つなら +Inf）
  scale: number;
  overflow: boolean;
}

function analyze(seatCount: number, seatIndex: number, melds: MeldInput[], selfSeat = false): Metrics {
  const { res, placed } = place(seatCount, seatIndex, melds, selfSeat);
  const sectorHalf = Math.PI / seatCount;
  let minPileClear = Infinity;
  let minOriginClear = Infinity;
  let maxSectorFrac = 0;
  for (const c of placed) {
    minPileClear = Math.min(minPileClear, distToCard(DECK.x, DECK.z, c), distToCard(DISCARD.x, DISCARD.z, c));
    minOriginClear = Math.min(minOriginClear, distToOrigin(c));
    maxSectorFrac = Math.max(maxSectorFrac, maxCornerAngle(c) / sectorHalf);
  }

  // 行ごと（u が一致）にグループ化して接線ギャップと段間ギャップを測る。
  const byRow = new Map<number, Placed[]>();
  for (const c of placed) {
    const key = Math.round(c.u * 1000);
    const arr = byRow.get(key) ?? [];
    arr.push(c);
    byRow.set(key, arr);
  }
  let minMeldGap = Infinity;
  for (const arr of byRow.values()) {
    arr.sort((a, b) => a.v - b.v);
    for (let k = 1; k < arr.length; k++) {
      const a = arr[k - 1]!;
      const b = arr[k]!;
      if (a.meldId === b.meldId) continue; // メルド内は意図的に重なる（扇状）ので除外
      minMeldGap = Math.min(minMeldGap, b.v - b.halfW - (a.v + a.halfW));
    }
  }
  const rowUs = [...byRow.keys()].map((k) => k / 1000).sort((a, b) => b - a);
  let minRowGap = Infinity;
  const halfH = placed[0]?.halfH ?? 0;
  for (let k = 1; k < rowUs.length; k++) {
    minRowGap = Math.min(minRowGap, rowUs[k - 1]! - rowUs[k]! - 2 * halfH);
  }

  return {
    minPileClear,
    minOriginClear,
    maxSectorFrac,
    minMeldGap,
    minRowGap,
    scale: res.scale,
    overflow: res.overflow,
  };
}

// 制約（overflow=false のケースで全て満たすこと）。
function expectSafe(m: Metrics, label: string): void {
  expect(m.overflow, `${label}: overflow`).toBe(false);
  expect(m.minPileClear, `${label}: 山札/捨て札クリアランス`).toBeGreaterThan(PILE_CLEAR);
  expect(m.minOriginClear, `${label}: 中央保護`).toBeGreaterThanOrEqual(ORIGIN_KEEP);
  expect(m.maxSectorFrac, `${label}: 隣席セクタ内`).toBeLessThan(1);
  if (Number.isFinite(m.minMeldGap)) expect(m.minMeldGap, `${label}: メルド間ギャップ`).toBeGreaterThan(0);
  if (Number.isFinite(m.minRowGap)) expect(m.minRowGap, `${label}: 段間ギャップ`).toBeGreaterThan(0);
}

const melds = (counts: number[]): MeldInput[] => counts.map((count, id) => ({ id, count }));

describe('メルド配置の幾何検証（契約11 E1）', () => {
  it('E1a: 6人卓・全席3メルド（各3枚）で全席が中央/隣席/ギャップ制約を満たす', () => {
    for (let seat = 0; seat < 6; seat++) {
      const m = analyze(6, seat, melds([3, 3, 3]));
      expectSafe(m, `6人 seat${seat}`);
      expect(m.scale).toBeGreaterThanOrEqual(0.42);
    }
  });

  it('E1b: 1人が10メルド（各3枚=30枚相当）でも収まる', () => {
    // 中央張り出しが最大の x 軸寄り席を含め全席で検証。
    for (let seat = 0; seat < 4; seat++) {
      const m = analyze(4, seat, melds(new Array(10).fill(3)));
      expectSafe(m, `4人10メルド seat${seat}`);
    }
    // 2人卓は広いセクタを使えるので更に余裕がある。
    expectSafe(analyze(2, 0, melds(new Array(10).fill(3))), '2人10メルド');
  });

  it('E1c: 13枚シークェンス単体は行を跨いで折り返し破綻しない', () => {
    for (const n of [2, 4, 6]) {
      const m = analyze(n, 0, melds([13]));
      expectSafe(m, `${n}人 13枚`);
    }
  });

  it('E1c2: 13枚シークェンス + 他メルド混在でも収まる', () => {
    expectSafe(analyze(4, 0, melds([13, 3, 3])), '4人 13+3+3');
    expectSafe(analyze(6, 1, melds([13, 4])), '6人 13+4');
  });

  it('E4(追補): 単独7（1枚メルド）多数でも中央非侵入・セクタ内', () => {
    expectSafe(analyze(6, 2, melds(new Array(6).fill(1))), '6人 単7×6');
  });

  it('E5(追補): メルドが伸びた混在（付け札で4〜7枚）でも収まる', () => {
    expectSafe(analyze(3, 0, melds([7, 5, 4, 3])), '3人 7+5+4+3');
  });

  it('少数メルドはフルサイズ（scale=1）を保つ', () => {
    // 中央張り出しの小さい z 方向席（seat0）で1メルドはフルサイズであるべき。
    expect(analyze(4, 0, melds([3])).scale).toBe(1);
  });

  it('メルドが増えるほどスケールは単調に縮小（または維持）する', () => {
    let prev = Infinity;
    for (const k of [1, 2, 4, 6, 8, 10]) {
      const s = analyze(6, 0, melds(new Array(k).fill(3))).scale;
      expect(s).toBeLessThanOrEqual(prev + 1e-9);
      prev = s;
    }
  });
});

// 自席（selfSeat=true）は付け札D&Dのため「手札帯より上」へメルドを寄せる（契約12 項目1a）。
// scene のカメラ投影実測（scratchpad/proj）で、半径 u < 1.62 のメルド中心は既定カメラで手札帯 top
// より上へ投影される（縦横とも）。ここでは u を代理指標に「最内帯・単一段・非自席より内側」を検証する。
describe('自席メルドの可視域配置（契約12 項目1a）', () => {
  const U_ABOVE = 1.62; // これ未満の u は既定カメラ（縦横）で手札帯 top より上に投影（proj 実測）
  const selfMaxU = (n: number, seat: number, ms: MeldInput[]): number =>
    Math.max(...place(n, seat, ms, true).placed.map((p) => p.u));
  const nonMaxU = (n: number, seat: number, ms: MeldInput[]): number =>
    Math.max(...place(n, seat, ms, false).placed.map((p) => p.u));
  const selfRows = (n: number, seat: number, ms: MeldInput[]): number =>
    new Set(place(n, seat, ms, true).placed.map((p) => Math.round(p.u * 1000))).size;

  it('自席レイアウトも中央保護/隣席不可侵/ギャップ制約を満たす（中央保護は自席でも不可侵）', () => {
    expectSafe(analyze(2, 0, melds([3, 3, 3]), true), '2人自席3メルド');
    for (let s = 0; s < 6; s++) expectSafe(analyze(6, s, melds([3, 3, 3]), true), `6人自席 seat${s}`);
    for (let s = 0; s < 4; s++) expectSafe(analyze(4, s, melds([3, 3, 3]), true), `4人自席 seat${s}`);
    // E1（現実的な混雑）: 5メルド / 13枚シークエンス+メルド は自席でも収容できる（overflow=false）。
    // 注: 25枚超（[13,3,3,3,3]=25 等）は 6p の狭セクタで自席/非自席とも overflow=true（R12 由来の
    // 幾何的上限・本契約の変更対象外）。現実のゲームで1席が25枚超の公開札を持つことはまず無い。
    expectSafe(analyze(6, 1, melds([3, 3, 3, 3, 3]), true), '6人自席 5メルド');
    expectSafe(analyze(6, 1, melds([13, 4]), true), '6人自席 13seq+4');
  });

  it('2人卓の自席メルドは単一段・最内帯（u<1.62=手札帯より上へ投影）', () => {
    expect(selfRows(2, 0, melds([3, 3, 3]))).toBe(1);
    expect(selfMaxU(2, 0, melds([3, 3, 3]))).toBeLessThan(U_ABOVE);
  });

  it('中央正対（dir.x≈0）の自席は単独メルドが最内帯（u<1.62）＝付け札可視域に置かれる', () => {
    // dir.x=0 の席（2p両席/4p seat0,2/6p seat0,3）は山札/捨て札が正面に無く中央側へ寄せられる。
    expect(selfMaxU(2, 0, melds([3]))).toBeLessThan(U_ABOVE);
    expect(selfMaxU(4, 0, melds([3]))).toBeLessThan(U_ABOVE);
    expect(selfMaxU(6, 0, melds([3]))).toBeLessThan(U_ABOVE);
  });

  it('自席は段数を最小化しメルドを内側へ寄せる＝最外 u が通常配置以下（外周へ伸ばさない）', () => {
    const cs: [number, number, number[]][] = [
      [2, 0, [3, 3]], [4, 0, [3, 3]], [4, 1, [3, 3, 3]],
      [6, 0, [3]], [6, 1, [3]], [6, 1, [3, 3, 3]], [6, 1, [13, 3, 3, 3, 3, 3]],
    ];
    for (const [n, s, arr] of cs)
      expect(selfMaxU(n, s, melds(arr)), `self<=non ${n}p seat${s}`).toBeLessThanOrEqual(
        nonMaxU(n, s, melds(arr)) + 1e-9,
      );
  });

  it('多メルド/混雑席でも段数最小化が効く（自席は非自席より確実に内側へ寄る）', () => {
    expect(selfMaxU(4, 0, melds([3, 3]))).toBeLessThan(nonMaxU(4, 0, melds([3, 3])));
    expect(selfMaxU(6, 0, melds([3]))).toBeLessThan(nonMaxU(6, 0, melds([3])));
    expect(selfMaxU(6, 1, melds([3]))).toBeLessThan(nonMaxU(6, 1, melds([3])));
    expect(selfMaxU(6, 1, melds([3, 3, 3]))).toBeLessThan(nonMaxU(6, 1, melds([3, 3, 3])));
  });
});
