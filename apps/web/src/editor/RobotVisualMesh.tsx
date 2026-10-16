import { useFrame } from '@react-three/fiber';
import {
  DELTA,
  linkThickness,
  type LinkPose,
  type RobotModel,
  type RobotVisual,
} from '@sim/domain';
import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Group } from 'three';
import { BASE_COLOR, Bar, Block, Cyl, EDGE_COLOR, type Highlight } from './meshes';

// Dibujo del robot a partir de RobotVisual: cada eslabón es un grupo cuya matriz sale de
// `linkPoses()`. Hoy la geometría de cada eslabón es simplificada; con el CAD se cambia este
// mapa de geometría por el GLB de cada eslabón, sin tocar la animación.

const LIGHT = '#e2e8f0';

/** Geometría simplificada de cada eslabón, en el marco propio del eslabón (mm). */
export function simplifiedLinkGeometry(
  model: RobotModel,
  color: string,
  tool: ReactNode,
): Record<string, ReactNode> {
  const d = model.dims;
  const base = model.base;
  const link = linkThickness(model);
  switch (model.kind) {
    case 'serial6':
      return {
        base: <Cyl r={base.radius} h={base.height * 0.5} color={BASE_COLOR} />,
        eje1: (
          <Cyl
            r={base.radius * 0.8}
            h={d.shoulder! - base.height * 0.5}
            z={base.height * 0.5}
            color={color}
          />
        ),
        eje2: <Block size={[link * 1.6, link * 1.6, d.upper!]} color={color} />,
        eje3: (
          <Block
            size={[d.fore!, link * 1.3, link * 1.3]}
            position={[d.fore! / 2, 0, -link * 0.65]}
            color={color}
          />
        ),
        eje5: (
          <Block
            size={[d.wrist!, link, link]}
            position={[d.wrist! / 2, 0, -link / 2]}
            color={LIGHT}
          />
        ),
        eje6: <Bar from={[0, 0, 0]} to={[link * 0.6, 0, 0]} r={link * 0.7} color={BASE_COLOR} />,
        brida: tool,
      };
    case 'palletizer4':
      return {
        base: <Cyl r={base.radius} h={base.height * 0.5} color={BASE_COLOR} />,
        eje1: (
          <Cyl
            r={base.radius * 0.85}
            h={d.shoulder! - base.height * 0.5}
            z={base.height * 0.5}
            color={color}
          />
        ),
        eje2: <Block size={[link * 2, link * 1.6, d.upper!]} color={color} />,
        eje3: (
          <Block
            size={[d.fore!, link * 1.4, link * 1.4]}
            position={[d.fore! / 2, 0, -link * 0.7]}
            color={color}
          />
        ),
        muñeca: (
          <Block
            size={[link * 1.2, link * 1.2, link * 2.5]}
            position={[0, 0, -link * 2.5]}
            color={LIGHT}
          />
        ),
        eje4: (
          <Block
            size={[link * 3, link * 3, link * 0.4]}
            position={[0, 0, -link * 0.4]}
            color={BASE_COLOR}
          />
        ),
        brida: tool,
      };
    case 'scara': {
      const rod = Math.max(d.stroke ?? 0, link * 2);
      return {
        base: (
          <>
            <Block
              size={[base.radius * 2.4, base.radius * 2.4, link]}
              position={[0, 0, -link]}
              color={BASE_COLOR}
            />
            <Cyl r={base.radius * 0.7} h={d.drop! - link} z={-d.drop!} color={color} />
          </>
        ),
        eje1: (
          <Block
            size={[d.arm1!, link * 2, link * 1.4]}
            position={[d.arm1! / 2, 0, -link * 1.4]}
            color={color}
          />
        ),
        eje2: (
          <Block
            size={[d.arm2!, link * 1.6, link * 1.2]}
            position={[d.arm2! / 2, 0, -link * 2.6]}
            color={color}
          />
        ),
        eje3: <Cyl r={link * 0.35} h={rod} z={-rod - link * 2.6} color={LIGHT} />,
        brida: tool,
      };
    }
    case 'delta': {
      const R = d.reach!;
      return {
        base: (
          <Cyl r={base.radius} h={base.height} z={-base.height} color={BASE_COLOR} segments={6} />
        ),
        ...Object.fromEntries(
          [1, 2, 3].flatMap((i) => [
            [
              `brazo${i}`,
              <Bar from={[0, 0, 0]} to={[DELTA.upper * R, 0, 0]} r={link * 0.5} color={color} />,
            ],
            [
              `antebrazo${i}`,
              <Bar from={[0, 0, 0]} to={[DELTA.lower * R, 0, 0]} r={link * 0.25} color="#cbd5e1" />,
            ],
          ]),
        ),
        plataforma: <Cyl r={d.platform_r!} h={link * 0.6} z={-link * 0.6} color={BASE_COLOR} />,
        brida: tool,
      };
    }
    case 'block':
      return { base: <Cyl r={base.radius} h={base.height} color={color} /> };
  }
}

/**
 * Robot dibujado por eslabón. `jointsAt` (opcional) da los valores de eje en cada cuadro de la
 * animación; sin él se usa la pose estática `joints`.
 */
export function RobotVisualMesh({
  visual,
  geometry,
  joints,
  jointsAt,
  highlight,
  baseRadius,
}: {
  visual: RobotVisual;
  geometry: Record<string, ReactNode>;
  joints: number[];
  jointsAt?: (() => number[]) | undefined;
  highlight: Highlight;
  baseRadius: number;
}) {
  const groups = useRef(new Map<string, Group>());
  const names = useMemo(() => visual.links.map((l) => l.name), [visual]);

  const apply = (poses: LinkPose[]) => {
    for (const p of poses) {
      const g = groups.current.get(p.name);
      if (!g) continue;
      g.matrix.fromArray(p.matrix);
      g.matrixWorldNeedsUpdate = true;
    }
  };
  useLayoutEffect(() => {
    if (jointsAt) return;
    visual.setJointValues(joints);
    apply(visual.linkPoses());
  });
  useFrame(() => {
    if (!jointsAt) return;
    visual.setJointValues(jointsAt());
    apply(visual.linkPoses());
  });

  return (
    <group>
      {highlight && (
        <mesh position={[0, 0, 2]}>
          <ringGeometry args={[baseRadius * 1.15, baseRadius * 1.3, 48]} />
          <meshBasicMaterial color={EDGE_COLOR[highlight]} />
        </mesh>
      )}
      {names.map((name) => (
        <group
          key={name}
          matrixAutoUpdate={false}
          ref={(g) => {
            if (g) groups.current.set(name, g);
            else groups.current.delete(name);
          }}
        >
          {geometry[name]}
        </group>
      ))}
    </group>
  );
}
