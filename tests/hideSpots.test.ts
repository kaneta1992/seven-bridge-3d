// 契約26(R28): かくれんぼ候補地カタログの検証。
// - 数（約100か所）・スケール下限（極端に小さく見えない）・部屋内に収まること
// - 決定性: 同じシードなら全クライアントで同じ2か所が選ばれる（P2P 同期の根拠）
// - 2体の距離条件（3m 以上離れた候補が常に取れる）
import { describe, expect, it } from 'vitest';
import { HIDE_SPOTS, hashSeed } from '../src/render/hideSpots';
import { shuffle } from '../src/core';

describe('かくれんぼ候補地（契約26）', () => {
  it('候補地カタログのうち、全席可視の採用分が100以上ある（2026-08-12 ユーザー要求）', () => {
    // R32 実測: 候補123 → 全席可視 101。難所（棚の中・天面・壁掛けの上・隙間・鉢の土）中心。
    expect(HIDE_SPOTS.length).toBeGreaterThanOrEqual(100);
  });

  it('全候補: スケール0.3以上（棚の中は干渉回避で0.32・2026-08-12ユーザー承認）・部屋内', () => {
    for (const p of HIDE_SPOTS) {
      expect(p.s).toBeGreaterThanOrEqual(0.3);
      expect(p.s).toBeLessThanOrEqual(0.85);
      expect(Math.abs(p.x)).toBeLessThan(9);
      expect(Math.abs(p.z)).toBeLessThan(9);
      expect(p.y).toBeGreaterThanOrEqual(-0.5);
      expect(p.y + 1.05 * p.s).toBeLessThan(6.1);
    }
  });

  it('決定性: 同一シード→同一順序、別シード→（ほぼ確実に）別の先頭', () => {
    const seed = hashSeed('ROOM42#3');
    const a = shuffle([...HIDE_SPOTS], seed).result;
    const b = shuffle([...HIDE_SPOTS], seed).result;
    expect(a).toEqual(b);
    const c = shuffle([...HIDE_SPOTS], hashSeed('ROOM42#4')).result;
    expect(c[0]).not.toEqual(a[0]);
  });

  it('任意のシードで「1体目から3m以上離れた2体目」が見つかる', () => {
    for (const s of ['A#1', 'B#2', 'C#3', 'ROOM#4', 'solo-xyz#5', 'Z#6']) {
      const order = shuffle([...HIDE_SPOTS], hashSeed(s)).result;
      const first = order[0]!;
      const second = order.find((p, i) => i > 0 && Math.hypot(p.x - first.x, p.z - first.z) >= 3);
      expect(second).toBeDefined();
    }
  });
});
