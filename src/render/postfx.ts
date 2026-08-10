// 選択的ポストプロセス（Selective Bloom）。three 同梱の examples モジュールのみ使用（外部依存なし）。
// 高ティアのみ有効。
//
// 【構造的除外（契約09 項目1）】
// カード・卓・席名など通常オブジェクトは既定レイヤ(0)のみに属する。エフェクト（光輪・パーティクル・
// ドロップ光枠）だけを BLOOM_LAYER(1) に載せる（scene.ts が obj.layers.enable(BLOOM_LAYER) する）。
// Bloom パスは camera.layers.set(BLOOM_LAYER) で「レイヤ1のオブジェクトだけ」を黒背景へ描画する。
// → カードはカメラの描画対象にすら入らないため、Bloom 合成経路へ構造的に一切混入しない
//   （材質を黒に差し替える方式と違い「一瞬カードが黒く映る」事故が原理的に起きない・E5/E7）。
// 最終パスは既定レイヤ(0)で通常描画し、Bloom テクスチャを加算合成する。
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** エフェクト専用レイヤ。このレイヤを enable したオブジェクトだけが Bloom 合成に載る。 */
export const BLOOM_LAYER = 1;

export interface PostFX {
  render(): void;
  setSize(w: number, h: number, dpr: number): void;
  dispose(): void;
  bloom: { value: number };
}

const MIX_VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// 通常描画（baseTexture）にブルーム（bloomTexture）を加算。発光だけが上乗せされ滲む。
const MIX_FRAG = `
  uniform sampler2D baseTexture;
  uniform sampler2D bloomTexture;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(baseTexture, vUv) + texture2D(bloomTexture, vUv);
  }
`;

/**
 * 選択的 Bloom コンポーザを構築。WebGL2/パスの初期化に失敗したら null を返し、呼び出し側は素の
 * renderer.render にフォールバックする（E7: ポストFX 非対応環境でも成立）。
 */
export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): PostFX | null {
  try {
    // --- Bloom パス（レイヤ1のみを黒背景に描画してから滲ませる） ---
    // 選択的除外後の Bloom 対象は加算合成の発光体のみになるため、閾値を 0 まで下げて派手に光らせる
    // （旧: 白飛び回避で閾値1.0まで上げ弱く滲ませていた制約から解放される・契約09 項目1/2）。
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), 1.15, 0.75, 0.0);
    const bloomComposer = new EffectComposer(renderer);
    bloomComposer.renderToScreen = false;
    bloomComposer.addPass(new RenderPass(scene, camera));
    bloomComposer.addPass(bloomPass);

    // --- 最終パス（通常描画 + Bloom 加算 + トーンマッピング/色空間変換） ---
    const mixMat = new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
      },
      vertexShader: MIX_VERT,
      fragmentShader: MIX_FRAG,
    });
    const mixPass = new ShaderPass(mixMat, 'baseTexture');
    mixPass.needsSwap = true;

    const finalComposer = new EffectComposer(renderer);
    finalComposer.addPass(new RenderPass(scene, camera));
    finalComposer.addPass(mixPass);
    finalComposer.addPass(new OutputPass());

    bloomComposer.setSize(w, h);
    finalComposer.setSize(w, h);

    const black = new THREE.Color(0, 0, 0);

    return {
      bloom: {
        get value(): number {
          return bloomPass.strength;
        },
        set value(v: number) {
          bloomPass.strength = v;
        },
      } as { value: number },
      render() {
        // 1) Bloom パス: レイヤ1（エフェクト）だけを黒背景へ描く。カード/卓/席名は描画対象外。
        const prevBg = scene.background;
        const prevFog = scene.fog;
        scene.background = black;
        scene.fog = null; // 発光体をフォグで減衰させない（純粋な発光だけを抽出）
        camera.layers.set(BLOOM_LAYER);
        try {
          bloomComposer.render();
        } finally {
          // 2) 状態を必ず復元（例外時も）。camera は既定レイヤ(0)へ戻す。
          camera.layers.set(0);
          scene.background = prevBg;
          scene.fog = prevFog;
        }
        // 3) 最終パス: 通常描画（全オブジェクト）に Bloom を加算合成。
        finalComposer.render();
      },
      setSize(nw: number, nh: number, dpr: number) {
        bloomComposer.setPixelRatio(dpr);
        finalComposer.setPixelRatio(dpr);
        bloomComposer.setSize(nw, nh);
        finalComposer.setSize(nw, nh);
        bloomPass.setSize?.(nw, nh);
        // Bloom 側のリサイズでレンダーターゲットが再生成されるため、mix の参照を更新（E6）。
        mixMat.uniforms.bloomTexture.value = bloomComposer.renderTarget2.texture;
      },
      dispose() {
        camera.layers.set(0);
        bloomComposer.dispose?.();
        finalComposer.dispose?.();
        bloomPass.dispose?.();
        mixMat.dispose();
      },
    };
  } catch {
    return null;
  }
}
