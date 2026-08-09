// ロビー設定の localStorage 永続化（項目7）。毎回の名前・人数・ラウンド数入力を不要にする。
// プライベートブラウズ等で localStorage が使えない環境でも例外で壊れず既定値へフォールバックする（E3）。
const KEY = 'sb_lobby';

export interface LobbyPrefs {
  name: string;
  maxPlayers: number; // ルーム作成の人数上限（2〜6）
  rounds: number; // 最後に選んだラウンド数
  hotseatCount: number; // ホットシートの人数（2〜6）
}

const DEFAULTS: LobbyPrefs = { name: '', maxPlayers: 4, rounds: 4, hotseatCount: 3 };

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;

/** 保存済み設定を読み出す。未保存・破損・アクセス不可のいずれでも既定値を返す（E3/E9）。 */
export function loadPrefs(): LobbyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw) as Partial<LobbyPrefs>;
    return {
      name: typeof p.name === 'string' ? p.name.slice(0, 10) : DEFAULTS.name,
      maxPlayers: clampInt(p.maxPlayers, 2, 6, DEFAULTS.maxPlayers),
      rounds: clampInt(p.rounds, 1, 99, DEFAULTS.rounds),
      hotseatCount: clampInt(p.hotseatCount, 2, 6, DEFAULTS.hotseatCount),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 設定を部分更新して保存する。書き込み不可環境では黙って破棄する（E3）。 */
export function savePrefs(patch: Partial<LobbyPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    /* private browsing 等: 永続化は諦める（挙動は既定値で継続） */
  }
}
