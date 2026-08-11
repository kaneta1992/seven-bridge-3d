// ジューシー化ラウンドで追加使用する three シンボルのアンビエント型シム。
// env.d.ts の `declare module 'three'` を拡張マージする（新規 npm 依存なし＝@types/three は入れない方針の継続）。
// このファイルは top-level の import/export を持たないスクリプト d.ts なので、
// env.d.ts のアンビエント宣言と同一モジュールに追記合成される。
declare module 'three' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnyX = any;
  export class MeshPhysicalMaterial { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class MeshBasicMaterial { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class ShaderMaterial { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class PointsMaterial { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class Points { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class BufferGeometry { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class BufferAttribute { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class Float32BufferAttribute { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class RingGeometry { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class BoxGeometry { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class ConeGeometry { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class Plane { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class Sprite { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class SpriteMaterial { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class Material { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class PointLight { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class PMREMGenerator { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class WebGLRenderTarget { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class Vector4 { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export class Matrix4 { [k: string]: AnyX; constructor(...a: AnyX[]); }
  export const MathUtils: AnyX;
  export const DynamicDrawUsage: AnyX;
  export const AdditiveBlending: AnyX;
  export const NormalBlending: AnyX;
  export const DoubleSide: AnyX;
  export const BackSide: AnyX;
  export const FrontSide: AnyX;
  export const EquirectangularReflectionMapping: AnyX;
  export const RepeatWrapping: AnyX;
}

declare module 'three/examples/jsm/postprocessing/EffectComposer.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class EffectComposer { [k: string]: any; constructor(...a: any[]); }
}
declare module 'three/examples/jsm/postprocessing/RenderPass.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class RenderPass { [k: string]: any; constructor(...a: any[]); }
}
declare module 'three/examples/jsm/postprocessing/UnrealBloomPass.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class UnrealBloomPass { [k: string]: any; constructor(...a: any[]); }
}
declare module 'three/examples/jsm/postprocessing/OutputPass.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class OutputPass { [k: string]: any; constructor(...a: any[]); }
}
declare module 'three/examples/jsm/postprocessing/ShaderPass.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class ShaderPass { [k: string]: any; constructor(...a: any[]); }
}
declare module 'three/examples/jsm/utils/BufferGeometryUtils.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function mergeGeometries(geometries: any[], useGroups?: boolean): any;
}
