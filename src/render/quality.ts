// 端末性能に応じた品質ティア判定（E1: モバイルでは自動的に品質を落とす / E6: 動きの抑制を尊重）。
// レンダラ生成前に一度だけ評価し、DPR上限・ポストFX有効・パーティクル上限・影解像度を段階化する。

export interface QualityTier {
  readonly name: 'high' | 'low';
  readonly maxDpr: number; // setPixelRatio の上限
  readonly bloom: boolean; // ポストFX（Bloom）を使うか
  readonly shadowMap: number; // 影マップ解像度
  readonly sparkCap: number; // スパーク粒子の最大同時数
  readonly confettiCap: number; // 紙吹雪粒子の最大同時数
  readonly cameraShake: boolean; // カメラシェイクを許可するか（reduced-motion で false）
  readonly envMap: boolean; // 反射用の環境マップを使うか
}

/** prefers-reduced-motion: 派手なカメラ演出・過剰な粒子を控える（アクセシビリティ / E6）。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** モバイル/低スペック相当かを保守的に推定する。誤検知しても「豪華すぎない」側に倒す。 */
function isLowPower(): boolean {
  const coarse =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  const smallSide = Math.min(window.innerWidth || 9999, window.innerHeight || 9999);
  const cores = navigator.hardwareConcurrency ?? 8;
  // 粗いポインタ（=タッチ）か、短辺が狭い（=スマホ相当）か、論理コアが少ない端末を低ティアに寄せる。
  return coarse || smallSide < 720 || cores <= 4;
}

export function detectQuality(): QualityTier {
  const reduced = prefersReducedMotion();
  if (isLowPower()) {
    return {
      name: 'low',
      maxDpr: 1.5,
      bloom: false,
      shadowMap: 1024,
      sparkCap: 160,
      confettiCap: 180,
      cameraShake: !reduced,
      envMap: false,
    };
  }
  return {
    name: 'high',
    maxDpr: 2,
    bloom: true,
    shadowMap: 2048,
    sparkCap: 420,
    confettiCap: 520,
    cameraShake: !reduced,
    envMap: true,
  };
}
