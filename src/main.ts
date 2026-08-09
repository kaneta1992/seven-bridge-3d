// UI エントリの最小プレースホルダ（後続フェーズで 3D / 通信を実装）。
import { createGame } from './core';

const game = createGame({
  players: [
    { id: 'p1', name: 'プレイヤー1' },
    { id: 'p2', name: 'プレイヤー2' },
  ],
});

const app = document.getElementById('app');
if (app) {
  app.textContent = `セブンブリッジ 3D — コア構築済み（phase: ${game.phase}）`;
}
