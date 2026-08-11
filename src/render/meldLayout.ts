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
//  - 行は「中心寄り（row0=中央保護の床）→ 外周方向」へ積む。最内行の中心を rc+halfH で床止めするため、
//    中央保護ゾーン（半径 rc）へは絶対に侵入しない（要件1）。
//  - 各カードの隅を席の角度セクタ（±(π/n)）内へ収める tan 制約で隣席と不可侵（要件2）。
//  - **同一メルドは決して行を跨がない**（契約18項目4: ユーザー実プレイで「K,A,2」と「3」が別行に
//    割れた不具合を解消）。メルドは「単位」で 1 行に置き、その行の幅に入らなければ次メルドを次行へ回す。
//  - 先頭メルドがその行（半径）の幅に収まらない場合は、より外周＝広いセクタの行へ送る。それでも
//    どの行にも入らなければカードスケールを段階的に縮小して収める（要件3・13枚シークエンスも1行+縮小）。
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

// 基準（最大）スケール。契約18項目5: 初期カードが大きく行に余裕が無かったため一回り縮小し、
// メルド行に横幅の余裕を持たせる（視認性と両立する範囲で 0.85）。少数メルドはこの値のまま置かれる。
const SCALE_MAX = 0.85;
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

interface Unit {
  id: number;
  count: number; // メルドのカード枚数（>=1）
}

/**
 * 1席分のメルドカードをローカル u,v へ配置する。収まる最大スケールを段階探索で選ぶ。
 * どのスケールでも収まらない場合は最小スケールで rim を越えてでも全カードを置き overflow=true を
 * 返す（カードは決して落とさない）。同一メルドは常に 1 行に収める（契約18項目4）。
 *
 * selfSeat=true（自席）: 付け札 D&D のためメルドを「手札帯より上＝内側バンド」に寄せる（契約12項目1a）。
 * 外周への押し出しを禁じ、収まらなければスケール縮小で内側に収める（契約18項目4「自席のスケール適応の
 * 踏襲でよい」に従う）。内側に収めるのが幾何的に不可能な長いメルド（例: 13枚シークエンス）は一般配置へ
 * フォールバックし、1 行のまま外周へ置く（no-split 優先）。
 */
export function layoutSeatMelds(
  seatCount: number,
  dirX: number,
  melds: MeldInput[],
  selfSeat = false,
): MeldLayout {
  const units: Unit[] = melds.map((m) => ({ id: m.id, count: Math.max(1, m.count) }));
  if (units.length === 0) return { scale: SCALE_MAX, slots: [], overflow: false };

  // 中央保護（山札/捨て札の非被覆）は全席で不可侵に保つ＝rc は共通（契約12: 中央保護維持）。
  const rc = centerKeepout(dirX);
  const sectorHalf = sectorHalfAngle(seatCount);

  // 探索方針（契約21項目1: 「別メルドの改行を優先→無理ならスケール」）。
  // 旧実装は自席で段数を最小化するため 1 段へ詰めてスケールを最小(0.43)まで落とし、複数メルドが
  // 極端に小さく潰れていた（=「1 行に収まらないと即スケール縮小」）。新実装はスケールを外側ループ＝
  // **大きいスケールを優先**し、その中で段数(rowCap)を 1,2,… と増やして別メルドを次段へ改行する。
  // 同一メルドが行を跨がない不変条件（R19/契約18項目4）は flow が保証する（メルドは単位で1行に載る）。
  //  - 自席: 付け札のため押し出し禁止(preferInner)で内側へ寄せる。同一スケールでは段数最小＝内側
  //    クラスタを優先（契約12項目1a）。ただし段を増やしても内側に入らない長いメルド（13枚等）は、
  //    スケールを段階的に下げても内側に収まらないため、最後に一般配置へフォールバックする。
  //  - 他席: 一般配置のみ（スケール外側ループ・flow が rowCap=∞ で自由に改行/外周押し出し）。
  if (selfSeat) {
    for (let k = 0; ; k++) {
      const s = Math.max(SCALE_MIN, round2(SCALE_MAX - k * SCALE_STEP));
      // 大きいスケールほど優先。同一スケール内では段数を増やして別メルドを改行（内寄せ・押し出し禁止）。
      for (const rowCap of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const slots = flow(units, s, rc, sectorHalf, false, true, rowCap);
        if (slots) return { scale: s, slots, overflow: false };
      }
      if (s <= SCALE_MIN + 1e-9) break;
    }
    // 内側(押し出し禁止)へどのスケールでも収まらない長いメルドは一般配置へフォールバック（1段・連続半径）。
    for (let k = 0; ; k++) {
      const s = Math.max(SCALE_MIN, round2(SCALE_MAX - k * SCALE_STEP));
      const slots = flow(units, s, rc, sectorHalf, false, false, Infinity);
      if (slots) return { scale: s, slots, overflow: false };
      if (s <= SCALE_MIN + 1e-9) break;
    }
  } else {
    for (let k = 0; ; k++) {
      const s = Math.max(SCALE_MIN, round2(SCALE_MAX - k * SCALE_STEP));
      const slots = flow(units, s, rc, sectorHalf, false, false, Infinity);
      if (slots) return { scale: s, slots, overflow: false };
      if (s <= SCALE_MIN + 1e-9) break;
    }
  }
  // 最小スケールでも収まらない（病的ケース: 極小セクタに超多数メルド）。溢れを許容し報告する。
  const slots = flow(units, SCALE_MIN, rc, sectorHalf, true, false, Infinity)!;
  return { scale: SCALE_MIN, slots, overflow: true };
}

/**
 * メルドを「単位」で行へ流し込む（契約18項目4: 同一メルドは絶対に行を跨がない）。
 * row0 を中央保護の床(rc+halfH)に置き、外周方向へ積む。行の接線幅 budget は半径 u に比例して
 * 広がるため、長いメルドは幅の足りる半径まで行を押し上げてから 1 行で置く（連続半径・13枚も1行）。
 *
 * 各行の手順:
 *  - まず先頭メルドがこの半径 u で収まるか見る。収まらなければ、収まる最小半径まで u を押し上げる
 *    （セクタは外周ほど広いので、押し上げれば必ず幅が足りる。ただし rim=bandHi を超えたら不可）。
 *    preferInner=true（自席）では押し上げを禁じ、収まらなければ null を返す（＝呼び出し側でスケール縮小）。
 *  - 確定した半径でメルド単位に「載るだけ」載せる。次メルドが行幅に入らなければ次行へ回す。
 *  - 次行の開始半径は今の行の外側（rowPitch 先）＝段間ギャップは常に正（要件4）。
 * force=false で rim を超える／セクタ最大幅(2*V_CAP)にすら入らないなら null（＝要スケール縮小）。
 * force=true では rim を越えてでも全メルドを置く（中央は依然侵さない・エスカレーション指標）。
 */
function flow(
  units: Unit[],
  s: number,
  rc: number,
  sectorHalf: number,
  force: boolean,
  preferInner: boolean,
  rowCap: number,
): CardSlot[] | null {
  const w = CARD_W * s;
  const step = STEP * s;
  const gap = MELD_GAP * s;
  const halfH = (CARD_H * s) / 2;
  const rowPitch = CARD_H * s + ROW_GAP * s; // 段間ピッチ（>h なので段間ギャップ>0）
  const bandLo = rc + halfH; // 最内行の中心半径（中央保護の床）
  const bandHi = R_RIM_EDGE - halfH; // 行の中心半径の上限（外縁が rim を越えない）
  const tanS = Math.tan(sectorHalf);
  // 半径 u の行の接線方向に使える全幅（行の最内隅の半径 u-halfH で角度が最も開く）。
  const budgetAt = (u: number): number => 2 * Math.min(V_CAP, Math.max(0.05, u - halfH) * tanS);
  if (bandHi < bandLo && !force) return null; // 席がカード1枚ぶんの帯すら確保できない → 縮小

  const slots: CardSlot[] = [];
  let j = 0; // 次に置くメルドの index
  let u = bandLo; // 次の行の中心半径の候補
  let row = 0; // 使用済み行数（自席の段数上限 rowCap の判定に使う）
  while (j < units.length) {
    if (row >= rowCap && !force) return null; // 段数上限超過（自席の内寄せ探索で縮小へ委ねる）
    const first0 = (units[j]!.count - 1) * step + w; // 先頭メルドの全幅
    let rowU = u;
    // 先頭メルドがこの半径で収まらなければ、収まる最小半径まで押し上げる（外周ほどセクタが広い）。
    // preferInner（自席）では押し出さず、縮小に委ねる（内側バンド維持・付け札可視域）。
    if (first0 > budgetAt(rowU) + 1e-9) {
      if (preferInner) return null;
      rowU = Math.max(u, first0 / (2 * tanS) + halfH);
    }
    // rim 超え／セクタ最大幅(2*V_CAP)にも入らない = このスケールでは無理 → 縮小（force なら rim へ寄せる）。
    if (rowU > bandHi + 1e-9 || first0 > 2 * V_CAP + 1e-9) {
      if (!force) return null;
      rowU = Math.max(bandLo, Math.min(rowU, bandHi));
    }
    const budget = budgetAt(rowU);

    // 確定した半径でメルド単位に載るだけ載せる。中心座標 pos を積算し、全幅 = 最終カード中心 + w。
    // メルド境界の中心間隔は w+gap（カード外縁どうしが gap 分離れる: 要件4 の正ギャップ保証）。
    // メルド内は step（<w なので適度に重なる扇状表示）。メルドは行を跨がない＝行に丸ごと載る単位。
    const rowUnits: { id: number; count: number; first: number }[] = [];
    let pos = 0; // 直近に置いたカードの中心（行内ローカル）
    let placed = false;
    while (j < units.length) {
      const cnt = units[j]!.count;
      const cellFirst = placed ? pos + w + gap : 0; // このメルド先頭カードの中心
      const last = cellFirst + (cnt - 1) * step; // 末尾カードの中心
      const fullWidth = last + w;
      // 途中メルドが行幅に入らなければ次行へ。force の先頭メルドは溢れを許容して置く。
      if (fullWidth > budget + 1e-9 && !(force && !placed)) break;
      rowUnits.push({ id: units[j]!.id, count: cnt, first: cellFirst });
      pos = last;
      placed = true;
      j++;
    }
    if (!placed) {
      // 先頭メルドの押し上げ後もこの行に載らない（force 時の rim クランプで幅不足）。溢れ許容で1つ置く。
      const cnt = units[j]!.count;
      rowUnits.push({ id: units[j]!.id, count: cnt, first: 0 });
      pos = (cnt - 1) * step;
      j++;
    }

    // 行内カードを中央寄せ（v = -span/2 .. +span/2）。span=最終カード中心（先頭カード中心=0）。
    const offset = -pos / 2;
    for (const ru of rowUnits) {
      for (let i = 0; i < ru.count; i++) {
        slots.push({ meldId: ru.id, index: i, u: rowU, v: offset + ru.first + i * step });
      }
    }
    u = rowU + rowPitch; // 次行は今の行の外側（段間ギャップ>0）
    row++;
  }
  return slots;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
