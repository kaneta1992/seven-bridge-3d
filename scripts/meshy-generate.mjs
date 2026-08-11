// Meshy Image-to-3D 生成スクリプト（ぬいぐるみ高品質化・契約24準備）
// 使い方:
//   MESHY_API_KEY=... node scripts/meshy-generate.mjs <入力画像パス> <出力名>
// 例:
//   MESHY_API_KEY=... node scripts/meshy-generate.mjs C:/Users/kanet/Pictures/plush/dalmatian.jpg dalmatian
// 出力: public/models/<出力名>.glb
// 注意: APIキーは環境変数でのみ渡す（コミット禁止）。入力写真はリポジトリ外に置くこと。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const API = 'https://api.meshy.ai/openapi/v1/image-to-3d';
const key = process.env.MESHY_API_KEY;
const [, , imagePath, outName] = process.argv;

if (!key) {
  console.error('MESHY_API_KEY 環境変数を設定してください');
  process.exit(1);
}
if (!imagePath || !outName) {
  console.error('使い方: node scripts/meshy-generate.mjs <入力画像パス> <出力名>');
  process.exit(1);
}

const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[
  extname(imagePath).toLowerCase()
];
if (!mime) {
  console.error('対応形式: jpg/png/webp');
  process.exit(1);
}

const b64 = readFileSync(resolve(imagePath)).toString('base64');
const dataUri = `data:${mime};base64,${b64}`;

const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

console.log(`[1/3] タスク投入: ${imagePath}`);
const create = await fetch(API, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    image_url: dataUri,
    ai_model: 'meshy-5',
    topology: 'triangle',
    target_polycount: 30000,
    should_texture: true,
    enable_pbr: false,
  }),
});
if (!create.ok) {
  console.error('タスク投入失敗:', create.status, await create.text());
  process.exit(1);
}
const { result: taskId } = await create.json();
console.log('taskId:', taskId);

console.log('[2/3] 生成待ち（数分かかります）…');
let task;
for (let i = 0; i < 240; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const res = await fetch(`${API}/${taskId}`, { headers });
  task = await res.json();
  const p = task.progress ?? 0;
  process.stdout.write(`\r  status=${task.status} progress=${p}%   `);
  if (task.status === 'SUCCEEDED') break;
  if (task.status === 'FAILED' || task.status === 'CANCELED') {
    console.error('\n生成失敗:', JSON.stringify(task.task_error ?? task, null, 2));
    process.exit(1);
  }
}
console.log();
if (task.status !== 'SUCCEEDED') {
  console.error('タイムアウト（20分）。taskId を控えて後で確認してください:', taskId);
  process.exit(1);
}

const glbUrl = task.model_urls?.glb;
if (!glbUrl) {
  console.error('GLB URLが見つかりません:', JSON.stringify(task.model_urls));
  process.exit(1);
}
console.log('[3/3] GLBダウンロード…');
const glb = await fetch(glbUrl);
const buf = Buffer.from(await glb.arrayBuffer());
mkdirSync('public/models', { recursive: true });
const out = `public/models/${outName}.glb`;
writeFileSync(out, buf);
console.log(`保存: ${out}（${(buf.length / 1024 / 1024).toFixed(2)} MB）`);
