// シード付き決定的乱数（mulberry32）。状態を数値で持ち、applyAction を純粋に保つため
// state に格納して回す。ホスト権威モデルでの再現性・テストの決定性を担保する。

export interface RngStep {
  /** 0 <= value < 1 の一様乱数 */
  readonly value: number;
  /** 次回に渡す新しい RNG 状態 */
  readonly state: number;
}

/** 1 ステップ進める。純粋関数: 同じ state からは常に同じ結果。 */
export function nextRng(state: number): RngStep {
  let a = state | 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, state: a };
}

/** Fisher-Yates シャッフル。新しい配列と次の RNG 状態を返す（元配列は不変）。 */
export function shuffle<T>(arr: readonly T[], seed: number): { result: T[]; seed: number } {
  const result = arr.slice();
  let state = seed;
  for (let i = result.length - 1; i > 0; i--) {
    const step = nextRng(state);
    state = step.state;
    const j = Math.floor(step.value * (i + 1));
    const tmp = result[i]!;
    result[i] = result[j]!;
    result[j] = tmp;
  }
  return { result, seed: state };
}
