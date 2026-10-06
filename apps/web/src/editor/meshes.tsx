import { Edges } from '@react-three/drei';
import type { RobotModel, SceneObject } from '@sim/domain';
import { useMemo } from 'react';
import { Quaternion, Vector3 } from 'three';

// Geometría simplificada. Todo en mm con Z hacia arriba (el lienzo convierte a metros y Y arriba).

const DEG = Math.PI / 180;
const BASE_COLOR = '#334155';

export type Highlight = 'selected' | 'warning' | null;
const EDGE_COLOR = { selected: '#2557e8', warning: '#f59e0b' } as const;

/** Caja con su cara inferior en z = 0. */
function Block({
  size,
  position = [0, 0, 0],
  color,
  highlight = null,
}: {
  size: [number, number, number];
  position?: [number, number, number];
  color: string;
  highlight?: Highlight;
}) {
  return (
    <mesh position={[position[0], position[1], position[2] + size[2] / 2]} castShadow receiveShadow>
      <boxGeometry args={size} />
      <meshStandardMaterial color={color} roughness={0.7} />
      {highlight && <Edges color={EDGE_COLOR[highlight]} lineWidth={2} />}
    </mesh>
  );
}

/** Cilindro de eje Z con su base en z = 0. */
function Cyl({
  r,
  h,
  color,
  z = 0,
  segments = 32,
}: {
  r: number;
  h: number;
  color: string;
  z?: number;
  segments?: number;
}) {
  return (
    <mesh position={[0, 0, z + h / 2]} rotation={[Math.PI / 2, 0, 0]} castShadow>
      <cylinderGeometry args={[r, r, h, segments]} />
      <meshStandardMaterial color={color} roughness={0.5} metalness={0.1} />
    </mesh>
  );
}

/** Barra entre dos puntos. */
function Bar({
  from,
  to,
  r,
  color,
}: {
  from: [number, number, number];
  to: [number, number, number];
  r: number;
  color: string;
}) {
  const { pos, quat, len } = useMemo(() => {
    const a = new Vector3(...from);
    const b = new Vector3(...to);
    const dir = b.clone().sub(a);
    const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
    return { pos: a.add(b).multiplyScalar(0.5), quat: q, len: dir.length() };
  }, [from, to]);
  return (
    <mesh position={pos} quaternion={quat} castShadow>
      <cylinderGeometry args={[r, r, len, 12]} />
      <meshStandardMaterial color={color} roughness={0.5} />
    </mesh>
  );
}

export function ObjectMesh({
  o,
  highlight,
}: {
  o: Exclude<SceneObject, { kind: 'robot' }>;
  highlight: Highlight;
}) {
  const { length_mm: l, width_mm: w, height_mm: h } = o.params;
  switch (o.kind) {
    case 'pallet': {
      // Tablero superior y tres patines: apariencia de pallet con las medidas exactas.
      const top = Math.min(30, h * 0.25);
      const runner = Math.min(100, w * 0.12);
      return (
        <group>
          <Block
            size={[l, w, top]}
            position={[0, 0, h - top]}
            color={o.color}
            highlight={highlight}
          />
          {[-1, 0, 1].map((k) => (
            <Block
              key={k}
              size={[l, runner, h - top]}
              position={[0, k * (w / 2 - runner / 2), 0]}
              color={o.color}
            />
          ))}
        </group>
      );
    }
    case 'table': {
      const top = Math.min(40, h * 0.1);
      const leg = Math.min(60, Math.min(l, w) * 0.1);
      return (
        <group>
          <Block
            size={[l, w, top]}
            position={[0, 0, h - top]}
            color={o.color}
            highlight={highlight}
          />
          {[
            [-1, -1],
            [1, -1],
            [-1, 1],
            [1, 1],
          ].map(([sx, sy]) => (
            <Block
              key={`${sx}${sy}`}
              size={[leg, leg, h - top]}
              position={[sx! * (l / 2 - leg / 2), sy! * (w / 2 - leg / 2), 0]}
              color="#64748b"
            />
          ))}
        </group>
      );
    }
    case 'conveyor': {
      const belt = Math.min(60, h * 0.15);
      const leg = Math.min(50, w * 0.1);
      return (
        <group>
          <Block
            size={[l, w, belt]}
            position={[0, 0, h - belt]}
            color="#1e293b"
            highlight={highlight}
          />
          <Block size={[l * 0.98, w * 0.9, 4]} position={[0, 0, h]} color={o.color} />
          {[-1, 1].flatMap((sx) =>
            [-1, 1].map((sy) => (
              <Block
                key={`${sx}${sy}`}
                size={[leg, leg, h - belt]}
                position={[sx * (l / 2 - leg), sy * (w / 2 - leg / 2), 0]}
                color="#94a3b8"
              />
            )),
          )}
        </group>
      );
    }
    case 'box':
      return <Block size={[l, w, h]} color={o.color} highlight={highlight} />;
  }
}

/** Valor de eje en radianes (revoluta) o mm (prismática). */
const jv = (model: RobotModel, values: number[], i: number) => {
  const j = model.joints[i];
  const v = values[i] ?? 0;
  if (!j) return 0;
  return j.type === 'revolute' ? v * DEG : v;
};

export function RobotMesh({
  model,
  joints,
  color,
  highlight,
}: {
  model: RobotModel;
  joints: number[];
  color: string;
  highlight: Highlight;
}) {
  const d = model.dims;
  const base = model.base;
  const ring = highlight && (
    <mesh position={[0, 0, model.inverted ? 2 : 2]}>
      <ringGeometry args={[base.radius * 1.15, base.radius * 1.3, 48]} />
      <meshBasicMaterial color={EDGE_COLOR[highlight]} />
    </mesh>
  );
  const link = Math.max(20, (d.reach ?? 1000) * 0.045);

  switch (model.kind) {
    case 'serial6':
      return (
        <group>
          {ring}
          <Cyl r={base.radius} h={base.height * 0.5} color={BASE_COLOR} />
          <group rotation={[0, 0, jv(model, joints, 0)]}>
            <Cyl
              r={base.radius * 0.8}
              h={d.shoulder! - base.height * 0.5}
              z={base.height * 0.5}
              color={color}
            />
            <group position={[0, 0, d.shoulder!]} rotation={[0, jv(model, joints, 1), 0]}>
              <Block size={[link * 1.6, link * 1.6, d.upper!]} color={color} />
              <group position={[0, 0, d.upper!]} rotation={[0, jv(model, joints, 2), 0]}>
                <Block
                  size={[d.fore!, link * 1.3, link * 1.3]}
                  position={[d.fore! / 2, 0, -link * 0.65]}
                  color={color}
                />
                <group position={[d.fore!, 0, 0]} rotation={[jv(model, joints, 3), 0, 0]}>
                  <group rotation={[0, jv(model, joints, 4), 0]}>
                    <Block
                      size={[d.wrist!, link, link]}
                      position={[d.wrist! / 2, 0, -link / 2]}
                      color="#e2e8f0"
                    />
                    <group position={[d.wrist!, 0, 0]} rotation={[jv(model, joints, 5), 0, 0]}>
                      <Bar
                        from={[0, 0, 0]}
                        to={[link * 0.6, 0, 0]}
                        r={link * 0.7}
                        color={BASE_COLOR}
                      />
                    </group>
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      );
    case 'palletizer4': {
      const q2 = jv(model, joints, 1);
      const q3 = jv(model, joints, 2);
      return (
        <group>
          {ring}
          <Cyl r={base.radius} h={base.height * 0.5} color={BASE_COLOR} />
          <group rotation={[0, 0, jv(model, joints, 0)]}>
            <Cyl
              r={base.radius * 0.85}
              h={d.shoulder! - base.height * 0.5}
              z={base.height * 0.5}
              color={color}
            />
            <group position={[0, 0, d.shoulder!]} rotation={[0, q2, 0]}>
              <Block size={[link * 2, link * 1.6, d.upper!]} color={color} />
              <group position={[0, 0, d.upper!]} rotation={[0, q3, 0]}>
                <Block
                  size={[d.fore!, link * 1.4, link * 1.4]}
                  position={[d.fore! / 2, 0, -link * 0.7]}
                  color={color}
                />
                {/* Paralelogramo: la herramienta queda vertical. */}
                <group position={[d.fore!, 0, 0]} rotation={[0, -(q2 + q3), 0]}>
                  <Block
                    size={[link * 1.2, link * 1.2, link * 2.5]}
                    position={[0, 0, -link * 2.5]}
                    color="#e2e8f0"
                  />
                  <group position={[0, 0, -link * 2.5]} rotation={[0, 0, jv(model, joints, 3)]}>
                    <Block
                      size={[link * 3, link * 3, link * 0.4]}
                      position={[0, 0, -link * 0.4]}
                      color={BASE_COLOR}
                    />
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      );
    }
    case 'scara':
      return (
        <group>
          {ring}
          <Block
            size={[base.radius * 2.4, base.radius * 2.4, link]}
            position={[0, 0, -link]}
            color={BASE_COLOR}
          />
          <Cyl r={base.radius * 0.7} h={d.drop! - link} z={-d.drop!} color={color} />
          <group position={[0, 0, -d.drop!]} rotation={[0, 0, jv(model, joints, 0)]}>
            <Block
              size={[d.arm1!, link * 2, link * 1.4]}
              position={[d.arm1! / 2, 0, -link * 1.4]}
              color={color}
            />
            <group position={[d.arm1!, 0, 0]} rotation={[0, 0, jv(model, joints, 1)]}>
              <Block
                size={[d.arm2!, link * 1.6, link * 1.2]}
                position={[d.arm2! / 2, 0, -link * 2.6]}
                color={color}
              />
              <group
                position={[d.arm2!, 0, jv(model, joints, 2)]}
                rotation={[0, 0, jv(model, joints, 3)]}
              >
                <Cyl
                  r={link * 0.35}
                  h={Math.max(d.stroke!, link * 2)}
                  z={-Math.max(d.stroke!, link * 2) - link * 2.6}
                  color="#e2e8f0"
                />
              </group>
            </group>
          </group>
        </group>
      );
    case 'delta': {
      const pr = d.platform_r!;
      const br = d.base_r!;
      const angles = [0, 120, 240].map((a) => a * DEG);
      return (
        <group>
          {ring}
          <Cyl r={base.radius} h={base.height} z={-base.height} color={BASE_COLOR} segments={6} />
          {angles.map((a) => {
            const shoulder: [number, number, number] = [
              Math.cos(a) * br,
              Math.sin(a) * br,
              -base.height,
            ];
            const elbow: [number, number, number] = [
              Math.cos(a) * br * 1.6,
              Math.sin(a) * br * 1.6,
              -d.drop! * 0.4,
            ];
            const wrist: [number, number, number] = [Math.cos(a) * pr, Math.sin(a) * pr, -d.drop!];
            return (
              <group key={a}>
                <Bar from={shoulder} to={elbow} r={link * 0.5} color={color} />
                <Bar from={elbow} to={wrist} r={link * 0.25} color="#cbd5e1" />
              </group>
            );
          })}
          <Cyl r={pr} h={link * 0.6} z={-d.drop! - link * 0.6} color={BASE_COLOR} />
        </group>
      );
    }
    case 'block':
      return (
        <group>
          {ring}
          <Cyl r={base.radius} h={base.height} color={color} />
        </group>
      );
  }
}

export function EnvelopeMesh({ model }: { model: RobotModel }) {
  const env = model.envelope;
  const mat = <meshBasicMaterial color="#3b6ff5" transparent opacity={0.07} depthWrite={false} />;
  const wire = (
    <meshBasicMaterial color="#3b6ff5" wireframe transparent opacity={0.18} depthWrite={false} />
  );
  if (env.type === 'sphere')
    return (
      <group position={[0, 0, env.center_z]}>
        <mesh>
          <sphereGeometry args={[env.radius, 48, 24]} />
          {mat}
        </mesh>
        <mesh>
          <sphereGeometry args={[env.radius, 24, 12]} />
          {wire}
        </mesh>
      </group>
    );
  if (env.type === 'cylinder' || env.type === 'annulus') {
    // Delta: sin altura publicada se dibuja un disco. SCARA: altura = carrera del eje 3.
    const h = env.height && env.height > 0 ? env.height : 4;
    return (
      <group position={[0, 0, env.top_z - h / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <mesh>
          <cylinderGeometry args={[env.radius, env.radius, h, 64, 1, true]} />
          {mat}
        </mesh>
        <mesh>
          <cylinderGeometry args={[env.radius, env.radius, h, 32, 1, true]} />
          {wire}
        </mesh>
      </group>
    );
  }
  return null;
}
