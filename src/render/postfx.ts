// ポストプロセス（Bloom）合成。three 同梱の examples モジュールのみ使用（外部依存なし）。
// 高ティアのみ有効。閾値を高めに取り「発光ハイライト（金縁・スポット・粒子）だけが滲む」よう調整し、
// 文字・UI は 3D の外（DOM オーバーレイ）なので白飛びの影響を受けない（プリモーテム E5）。
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface PostFX {
  render(): void;
  setSize(w: number, h: number, dpr: number): void;
  dispose(): void;
  bloom: { value: number };
}

/**
 * Bloom コンポーザを構築。WebGL2/パスの初期化に失敗したら null を返し、呼び出し側は素の renderer.render に
 * フォールバックする（E7: ポストFX 非対応環境でも成立）。
 */
export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  w: number,
  h: number,
): PostFX | null {
  try {
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    // 2026-08-11 白飛び修正: 閾値0.82は白カード面の通常輝度が超えてしまいPC(高ティア)で
    // カードが読めなくなった（ユーザー報告）。閾値1.0=トーンマッピング前のHDR超過
    // （加算合成の光輪・パーティクル・強スポット直下）だけが滲む設定にし、強度・半径も抑制。
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.3, 0.45, 1.0);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    composer.setSize(w, h);
    const base = bloom.strength as number;
    return {
      bloom: {
        get value(): number {
          return bloom.strength;
        },
        set value(v: number) {
          bloom.strength = v;
        },
      } as { value: number },
      render() {
        composer.render();
      },
      setSize(nw: number, nh: number, dpr: number) {
        composer.setPixelRatio(dpr);
        composer.setSize(nw, nh);
        if (bloom.setSize) bloom.setSize(nw, nh);
      },
      dispose() {
        bloom.strength = base;
        composer.dispose?.();
        bloom.dispose?.();
      },
    };
  } catch {
    return null;
  }
}
