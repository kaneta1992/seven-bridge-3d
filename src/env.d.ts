// アンビエント宣言。
// three@0.169 は型定義（@types/three）を同梱せず、契約02 では依存追加が禁止のため、
// 使用する three シンボルを any 型のクラス/定数として最小宣言する（新規 npm 依存なし）。
// class 宣言は「型」と「値」の両方を生むため、型注釈（THREE.Vector3）と生成（new THREE.Vector3()）の双方に使える。
// NOTE(scope-out): 将来 @types/three を devDependency に追加すれば 3D 層に完全な型が付く。
declare module 'three' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;
  export class Texture { [k: string]: Any; constructor(...a: Any[]); }
  export class CanvasTexture { [k: string]: Any; constructor(...a: Any[]); }
  export class Group { [k: string]: Any; constructor(...a: Any[]); }
  export class Vector3 { [k: string]: Any; constructor(...a: Any[]); }
  export class Quaternion { [k: string]: Any; constructor(...a: Any[]); }
  export class Euler { [k: string]: Any; constructor(...a: Any[]); }
  export class WebGLRenderer { [k: string]: Any; constructor(...a: Any[]); }
  export class Scene { [k: string]: Any; constructor(...a: Any[]); }
  export class PerspectiveCamera { [k: string]: Any; constructor(...a: Any[]); }
  export class PlaneGeometry { [k: string]: Any; constructor(...a: Any[]); }
  export class CylinderGeometry { [k: string]: Any; constructor(...a: Any[]); }
  export class TorusGeometry { [k: string]: Any; constructor(...a: Any[]); }
  export class CircleGeometry { [k: string]: Any; constructor(...a: Any[]); }
  export class MeshStandardMaterial { [k: string]: Any; constructor(...a: Any[]); }
  export class Mesh { [k: string]: Any; constructor(...a: Any[]); }
  export class AmbientLight { [k: string]: Any; constructor(...a: Any[]); }
  export class HemisphereLight { [k: string]: Any; constructor(...a: Any[]); }
  export class DirectionalLight { [k: string]: Any; constructor(...a: Any[]); }
  export class SpotLight { [k: string]: Any; constructor(...a: Any[]); }
  export class Color { [k: string]: Any; constructor(...a: Any[]); }
  export class Fog { [k: string]: Any; constructor(...a: Any[]); }
  export class Clock { [k: string]: Any; constructor(...a: Any[]); }
  export const SRGBColorSpace: Any;
  export const LinearMipmapLinearFilter: Any;
  export const LinearFilter: Any;
  export const ACESFilmicToneMapping: Any;
  export const PCFSoftShadowMap: Any;
}

declare module 'three/examples/jsm/geometries/RoundedBoxGeometry.js' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export class RoundedBoxGeometry { [k: string]: any; constructor(...a: any[]); }
}

declare module '*.css';
