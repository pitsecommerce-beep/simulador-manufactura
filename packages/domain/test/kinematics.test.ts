import { describe, expect, it } from 'vitest';
import {
  buildRobotModel,
  m4,
  simplifiedVisual,
  type RobotVisual,
  type Vec3,
} from '../src/index.ts';
import { deg, IRB1300, IRB360, IRB460, IRB910 } from './fixtures.ts';

const DOWN: Vec3 = [0, 0, -1];

/** Comprueba que la solución esté en rango y que la pose directa llegue al objetivo. */
function expectReached(v: RobotVisual, target: Vec3) {
  const r = v.solve({ position: target, approach: DOWN });
  expect(r.reached, r.reason ?? '').toBe(true);
  expect(r.error_mm).toBeLessThan(1);
  r.joints.forEach((q, i) => {
    const j = v.joints[i]!;
    if (j.min != null) expect(q).toBeGreaterThanOrEqual(j.min - 1e-9);
    if (j.max != null) expect(q).toBeLessThanOrEqual(j.max + 1e-9);
  });
  v.setJointValues(r.joints);
  const tool = v.toolPose();
  expect(m4.norm(m4.sub(tool.position, target))).toBeLessThan(1);
  expect(m4.dot(tool.approach, DOWN)).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
  return r;
}

describe('cinemática inversa sobre la cadena simplificada', () => {
  it('robot serie de 6 ejes: llega con la herramienta hacia abajo dentro de los rangos', () => {
    const v = simplifiedVisual(buildRobotModel(IRB1300));
    for (const t of [
      [700, 0, 300],
      [400, 500, 150],
      [-300, -650, 500],
    ] as Vec3[])
      expectReached(v, t);
  });

  it('un punto fuera del alcance no se alcanza y los ejes quedan en rango', () => {
    const v = simplifiedVisual(buildRobotModel(IRB1300));
    const r = v.solve({ position: [4000, 0, 200], approach: DOWN });
    expect(r.reached).toBe(false);
    expect(r.reason).toMatch(/fuera del alcance/);
    r.joints.forEach((q, i) => {
      expect(q).toBeGreaterThanOrEqual(v.joints[i]!.min!);
      expect(q).toBeLessThanOrEqual(v.joints[i]!.max!);
    });
  });

  it('respeta un rango de eje estrecho: no gira el eje 1 más allá de la ficha', () => {
    const narrow = {
      ...IRB1300,
      axis_limits: [deg(1, -10, 10), ...IRB1300.axis_limits!.slice(1)],
    };
    const v = simplifiedVisual(buildRobotModel(narrow));
    expectReached(v, [700, 50, 300]);
    const r = v.solve({ position: [0, 700, 300], approach: DOWN });
    expect(r.reached).toBe(false);
    expect(Math.abs(r.joints[0]!)).toBeLessThanOrEqual(10);
  });

  it('paletizador de 4 ejes (IRB 460): herramienta siempre vertical', () => {
    const v = simplifiedVisual(buildRobotModel(IRB460));
    expectReached(v, [1600, 0, 400]);
    expectReached(v, [0, -1800, 900]);
  });

  it('SCARA invertido (IRB 910INV): baja con el eje 3 dentro de su carrera', () => {
    const model = buildRobotModel(IRB910);
    const v = simplifiedVisual(model);
    v.setJointValues([0, 0, 0, 0]);
    const z0 = v.toolPose().position[2];
    const r = expectReached(v, [200, 150, z0 - 80]);
    expect(r.joints[2]).toBeCloseTo(-80, 0);
    expect(v.solve({ position: [200, 150, z0 - 200], approach: DOWN }).reached).toBe(false);
  });

  it('delta (IRB 360): alcanza dentro del diámetro publicado y rechaza fuera', () => {
    const v = simplifiedVisual(buildRobotModel(IRB360));
    expect(v.notes.join(' ')).toMatch(/no publica rangos de eje ni la altura/);
    const home = v.toolPose().position;
    for (const t of [
      [0, 0, home[2] - 50],
      [300, 200, home[2] - 100],
      [-400, 100, home[2] - 20],
    ] as Vec3[])
      expectReached(v, t);
    expect(v.solve({ position: [600, 0, home[2] - 50] }).reason).toMatch(/diámetro de trabajo/);
    expect(v.solve({ position: [0, 0, home[2] + 50] }).reached).toBe(false);
  });

  it('un robot sin ejes publicados no se mueve', () => {
    const v = simplifiedVisual(
      buildRobotModel({ ...IRB1300, axes_count: null, axis_limits: null }),
    );
    const r = v.solve({ position: [500, 0, 300] });
    expect(r.reached).toBe(false);
  });

  it('la pose de los eslabones sigue la cadena (eje 1 gira todo lo que cuelga de él)', () => {
    const v = simplifiedVisual(buildRobotModel(IRB1300));
    v.setJointValues([0, 0, 0, 0, 0, 0]);
    const a = v.toolPose().position;
    v.setJointValues([90, 0, 0, 0, 0, 0]);
    const b = v.toolPose().position;
    expect(b[0]).toBeCloseTo(-a[1], 6);
    expect(b[1]).toBeCloseTo(a[0], 6);
    expect(v.linkPoses().map((l) => l.name)).toEqual([
      'base',
      'eje1',
      'eje2',
      'eje3',
      'eje4',
      'eje5',
      'eje6',
      'brida',
    ]);
    // setJointValues recorta a los rangos de la ficha.
    v.setJointValues([500, 0, 0, 0, 0, 0]);
    expect(v.jointValues()[0]).toBe(180);
  });
});
