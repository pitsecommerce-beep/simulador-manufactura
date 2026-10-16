// Matrices 4×4 de transformación rígida, en orden por columnas (como three.js: se pueden
// pasar a Matrix4.fromArray sin convertir). Milímetros y radianes.

import type { Vec3 } from './validate.ts';

export type { Vec3 };
export type Mat4 = number[];

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}

export const translation = ([x, y, z]: Vec3): Mat4 => [
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  0,
  1,
  0,
  x,
  y,
  z,
  1,
];

/** Giro de `angle` rad alrededor de un eje unitario (Rodrigues). */
export function rotation(axis: Vec3, angle: number): Mat4 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y + s * z,
    t * x * z - s * y,
    0,
    t * x * y - s * z,
    t * y * y + c,
    t * y * z + s * x,
    0,
    t * x * z + s * y,
    t * y * z - s * x,
    t * z * z + c,
    0,
    0,
    0,
    0,
    1,
  ];
}

/** Origen tipo URDF: traslación y luego giros roll (X), pitch (Y), yaw (Z) fijos. */
export function fromOrigin(xyz: Vec3, rpy: Vec3 = [0, 0, 0]): Mat4 {
  let m = translation(xyz);
  if (rpy[2]) m = multiply(m, rotation([0, 0, 1], rpy[2]));
  if (rpy[1]) m = multiply(m, rotation([0, 1, 0], rpy[1]));
  if (rpy[0]) m = multiply(m, rotation([1, 0, 0], rpy[0]));
  return m;
}

export const transformPoint = (m: Mat4, [x, y, z]: Vec3): Vec3 => [
  m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
  m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
  m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
];

export const transformDir = (m: Mat4, [x, y, z]: Vec3): Vec3 => [
  m[0]! * x + m[4]! * y + m[8]! * z,
  m[1]! * x + m[5]! * y + m[9]! * z,
  m[2]! * x + m[6]! * y + m[10]! * z,
];

export const origin = (m: Mat4): Vec3 => [m[12]!, m[13]!, m[14]!];
export const axisX = (m: Mat4): Vec3 => [m[0]!, m[1]!, m[2]!];
export const axisY = (m: Mat4): Vec3 => [m[4]!, m[5]!, m[6]!];
export const axisZ = (m: Mat4): Vec3 => [m[8]!, m[9]!, m[10]!];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const lerp = (a: Vec3, b: Vec3, f: number): Vec3 => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
];
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 1e-12 ? scale(a, 1 / n) : [0, 0, 0];
}

/** Matriz cuyo eje X va de `from` a `to` (para dibujar barras entre dos puntos). */
export function lookAlong(from: Vec3, to: Vec3): Mat4 {
  const x = normalize(sub(to, from));
  const ref: Vec3 = Math.abs(x[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const y = normalize(cross(ref, x));
  const z = cross(x, y);
  return [...x, 0, ...y, 0, ...z, 0, ...from, 1];
}
