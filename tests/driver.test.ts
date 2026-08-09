// ドライバ層の統合スモークテスト: LocalDriver 越しに全ゲームフローを回し切れることを検証。
// UI を介さず「アクション送信 / スナップショット受信」の抽象だけでラウンド完走できることを保証する。
import { describe, expect, it } from 'vitest';
import { LocalDriver } from '../src/driver/localDriver';

/** 常に合法手を選び、ゲーム終了まで自動対局を進める（メルド/付け札はせず単純にツモ→捨て）。 */
async function autoPlay(driver: LocalDriver, maxSteps = 5000): Promise<void> {
  for (let step = 0; step < maxSteps; step++) {
    const cur = driver.currentPlayerId();
    const view = driver.getView(cur);
    if (view.finished) return;

    switch (view.phase) {
      case 'awaitingStart':
      case 'roundOver': {
        const r = await driver.dispatch({ type: 'startRound' });
        expect(r.ok).toBe(true);
        break;
      }
      case 'awaitingDraw': {
        const r = await driver.dispatch({ type: 'draw', player: cur });
        expect(r.ok).toBe(true);
        break;
      }
      case 'awaitingDiscard': {
        const card = view.hand[0]!;
        const r = await driver.dispatch({ type: 'discard', player: cur, card });
        expect(r.ok).toBe(true);
        break;
      }
      case 'meldWindow': {
        // 全員パス（ホットシートで鳴きを行わない最短進行）。
        const top = driver.claimants()[0];
        if (top) {
          const r = await driver.dispatch({ type: 'pass', player: top.playerId });
          expect(r.ok).toBe(true);
        } else {
          await driver.dispatch({ type: 'closeWindow' });
        }
        break;
      }
      case 'gameOver':
        return;
    }
  }
  throw new Error('autoPlay: exceeded maxSteps without finishing');
}

describe('LocalDriver ホットシート統合', () => {
  it('2人卓・1ラウンドを完走して gameOver に達する', async () => {
    const driver = new LocalDriver({
      players: [
        { id: 'p1', name: 'あかね' },
        { id: 'p2', name: 'ひかり' },
      ],
      totalRounds: 1,
      seed: 42,
    });
    await autoPlay(driver);
    const view = driver.getView('p1');
    expect(view.finished).toBe(true);
    expect(view.phase).toBe('gameOver');
    expect(view.scores.length).toBe(1);
    expect(view.finalWinners.length).toBeGreaterThanOrEqual(1);
  });

  it('6人卓・3ラウンドを完走しスコアが全ラウンド集計される', async () => {
    const names = ['あ', 'い', 'う', 'え', 'お', 'か'];
    const driver = new LocalDriver({
      players: names.map((n, i) => ({ id: `p${i}`, name: n })),
      totalRounds: 3,
      seed: 7,
    });
    await autoPlay(driver);
    const view = driver.getView('p0');
    expect(view.finished).toBe(true);
    expect(view.scores.length).toBe(3);
    // 各ラウンド行は席数ぶんの失点を持つ
    for (const row of view.scores) expect(row.length).toBe(6);
  });

  it('購読リスナが dispatch のたびに発火する', async () => {
    const driver = new LocalDriver({
      players: [
        { id: 'p1', name: 'A' },
        { id: 'p2', name: 'B' },
      ],
      totalRounds: 1,
      seed: 1,
    });
    let calls = 0;
    const off = driver.subscribe(() => {
      calls++;
    });
    await driver.dispatch({ type: 'startRound' });
    expect(calls).toBe(1);
    off();
    await driver.dispatch({ type: 'draw', player: driver.currentPlayerId() });
    expect(calls).toBe(1); // 解除後は発火しない
  });
});
