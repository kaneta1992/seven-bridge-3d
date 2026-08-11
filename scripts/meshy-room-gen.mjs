// R27: Meshy text-to-3D で居間のヒーロー家具を一括生成するスクリプト（契約25）。
// - APIキーは ~/.meshy_key.txt から読む。ログ・標準出力へは絶対に出さない。
// - 全アイテムの preview を先に投げ、成功した順に refine → GLB ダウンロード。
// - state.json に task id を永続化し、再実行時は途中から再開する（クレジット節約）。
// 実行: node scripts/meshy-room-gen.mjs  （出力: assets-src/meshy-room/*.glb）
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KEY = readFileSync('C:/Users/kanet/.meshy_key.txt', 'utf8').replace(/[\r\n\s]/g, '');
const OUT = 'assets-src/meshy-room';
const STATE_FILE = join(OUT, 'state.json');
const API = 'https://api.meshy.ai/openapi/v2/text-to-3d';

// 家具リスト。prompt は英語（Meshy の得意言語）。poly は preview の target_polycount。
// 配置・スケールは統合スクリプト側（merge-furniture.mjs）の PLACEMENTS が担う。
const ITEMS = [
  { name: 'sofa', poly: 12000, prompt: 'cozy modern 3-seat sofa, slate blue fabric upholstery, plush seat cushions and back cushions, low wooden legs, living room furniture, clean silhouette' },
  { name: 'armchair', poly: 8000, prompt: 'cozy fabric armchair, slate blue upholstery matching a modern sofa set, plush cushion, low wooden legs' },
  { name: 'bookshelf', poly: 14000, prompt: 'tall wooden bookshelf completely filled with many colorful books, six shelves, warm brown wood, a few books leaning at an angle, cozy living room' },
  { name: 'sideboard', poly: 8000, prompt: 'mid-century wooden sideboard cabinet with four drawers, small brass handles, warm walnut wood, living room furniture' },
  { name: 'sidetable', poly: 4000, prompt: 'small round wooden side table, warm walnut wood, single turned pedestal leg' },
  { name: 'coffeetable', poly: 5000, prompt: 'low rectangular wooden coffee table, walnut wood, rounded corners, simple sturdy legs' },
  { name: 'floorlamp', poly: 4000, prompt: 'floor lamp with warm cream fabric drum shade, dark slim metal pole, round metal base' },
  { name: 'plant', poly: 9000, prompt: 'potted monstera houseplant in a terracotta clay pot, lush green split leaves, indoor plant' },
  { name: 'tvstand', poly: 9000, prompt: 'retro wooden TV stand cabinet with a vintage television set on top, warm cozy living room style' },
  { name: 'basket', poly: 5000, prompt: 'round woven rattan storage basket with a folded cream blanket draped over the rim' },
  { name: 'pouf', poly: 3000, prompt: 'round knitted pouf ottoman, mustard yellow chunky knit fabric' },
  { name: 'wallshelf', poly: 6000, prompt: 'wooden wall-mounted floating shelf decorated with two small potted plants and a short row of books' },
];

mkdirSync(OUT, { recursive: true });
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitTask(id, label) {
  for (;;) {
    const t = await api('GET', `/${id}`);
    if (t.status === 'SUCCEEDED') return t;
    if (t.status === 'FAILED' || t.status === 'CANCELED')
      throw new Error(`${label}: ${t.status} ${t.task_error?.message ?? ''}`);
    await sleep(12000);
  }
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function run(item) {
  const st = (state[item.name] ??= {});
  try {
    if (!st.preview) {
      const r = await api('POST', '', {
        mode: 'preview', prompt: item.prompt, art_style: 'realistic', ai_model: 'meshy-5',
        topology: 'triangle', target_polycount: item.poly, should_remesh: true,
      });
      st.preview = r.result;
      save();
      log(`${item.name}: preview 開始 (${st.preview})`);
    }
    if (!st.refine) {
      await waitTask(st.preview, `${item.name} preview`);
      log(`${item.name}: preview 完了 → refine 開始`);
      const r = await api('POST', '', { mode: 'refine', preview_task_id: st.preview, enable_pbr: false });
      st.refine = r.result;
      save();
    }
    if (!st.done) {
      const t = await waitTask(st.refine, `${item.name} refine`);
      const glb = t.model_urls?.glb;
      if (!glb) throw new Error(`${item.name}: GLB URL なし`);
      await download(glb, join(OUT, `${item.name}.glb`));
      st.done = true;
      save();
      log(`${item.name}: ✅ ダウンロード完了`);
    } else {
      log(`${item.name}: 済み（スキップ）`);
    }
  } catch (e) {
    st.error = String(e.message ?? e);
    save();
    log(`${item.name}: ❌ ${st.error}`);
  }
}

// 全件並行（Meshy 側キューが捌く）。ネットワーク瞬断に備え1回だけ全体リトライ。
log(`生成開始: ${ITEMS.length} 点`);
await Promise.all(ITEMS.map(run));
const failed = ITEMS.filter((i) => !state[i.name]?.done);
if (failed.length) {
  log(`リトライ: ${failed.map((i) => i.name).join(', ')}`);
  for (const i of failed) delete state[i.name]?.error;
  await Promise.all(failed.map(run));
}
const ok = ITEMS.filter((i) => state[i.name]?.done).map((i) => i.name);
log(`完了: ${ok.length}/${ITEMS.length} — ${ok.join(', ')}`);
