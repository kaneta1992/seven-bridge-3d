// エントリ: HUD + 3D シーンのオーケストレータを起動する。
// ゲームロジックには触れず、ドライバ境界（GameDriver）越しに動作する（契約03 でネットワーク実装に差し替え可能）。
import './ui/styles.css';
import { GameUI } from './ui/app';

const app = document.getElementById('app');
if (app) {
  new GameUI(app);
}
