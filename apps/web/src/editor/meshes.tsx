import { Edges } from '@react-three/drei';
import { VISUAL_SIZE, type RobotModel, type SceneObject, type WorkObject } from '@sim/domain';
import { useMemo } from 'react';
import { Quaternion, Vector3 } from 'three';

// Geometría simplificada. Todo en mm con Z hacia arriba (el lienzo convierte a metros y Y arriba).

export const BASE_COLOR = '#334155';

/** Resaltado: selección, advertencia o, durante la reproducción, el estado de la estación. */
export type Highlight = 'selected' | 'warning' | 'busy' | 'blocked' | 'idle' | 'failed' | null;
export const EDGE_COLOR = {
  selected: '#2557e8',
  warning: '#f59e0b',
  busy: '#10b981',
  blocked: '#f59e0b',
  idle: '#94a3b8',
  failed: '#ef4444',
} as const;

/** Caja con su cara inferior en z = 0. */
export function Block({
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
export function Cyl({
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
export function Bar({
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

export function ObjectMesh({ o, highlight }: { o: WorkObject; highlight: Highlight }) {
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

/** Gripper simplificado: cuerpo y dos dedos, colgando hacia -Z desde el origen (la brida). */
export function GripperMesh({ color, highlight }: { color: string; highlight: Highlight }) {
  const { length_mm: l, width_mm: w, height_mm: h } = VISUAL_SIZE.gripper;
  const body = h * 0.55;
  const finger = h - body;
  return (
    <group>
      <Block size={[l, w, body]} position={[0, 0, -body]} color={color} highlight={highlight} />
      {[-1, 1].map((k) => (
        <Block
          key={k}
          size={[l * 0.18, w * 0.8, finger]}
          position={[k * l * 0.3, 0, -h]}
          color="#cbd5e1"
        />
      ))}
    </group>
  );
}

export function SensorMesh({ color, highlight }: { color: string; highlight: Highlight }) {
  const { length_mm: l, width_mm: w, height_mm: h } = VISUAL_SIZE.sensor;
  return (
    <group>
      <Block size={[l, w, h]} color={color} highlight={highlight} />
      <mesh position={[l / 2 + 2, 0, h / 2]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[w * 0.25, w * 0.25, 4, 16]} />
        <meshStandardMaterial color="#0f172a" />
      </mesh>
    </group>
  );
}

export function FenceMesh({
  o,
  highlight,
}: {
  o: Extract<SceneObject, { kind: 'fence' }>;
  highlight: Highlight;
}) {
  const { length_mm: l, height_mm: h, thickness_mm: t } = o.params;
  const posts = Math.max(2, Math.ceil(l / 1400) + 1);
  return (
    <group>
      <mesh position={[0, 0, h / 2 + 100]}>
        <boxGeometry args={[l, t * 0.4, h - 200]} />
        <meshStandardMaterial color={o.color} transparent opacity={0.35} depthWrite={false} />
        {highlight && <Edges color={EDGE_COLOR[highlight]} lineWidth={2} />}
      </mesh>
      {Array.from({ length: posts }, (_, i) => (
        <Block
          key={i}
          size={[t, t, h]}
          position={[-l / 2 + t / 2 + (i * (l - t)) / (posts - 1), 0, 0]}
          color="#334155"
        />
      ))}
    </group>
  );
}

export function SafetyZoneMesh({
  o,
  highlight,
}: {
  o: Extract<SceneObject, { kind: 'safety_zone' }>;
  highlight: Highlight;
}) {
  const { length_mm: l, width_mm: w } = o.params;
  return (
    <mesh position={[0, 0, 3]}>
      <boxGeometry args={[l, w, 4]} />
      <meshBasicMaterial color={o.color} transparent opacity={0.28} depthWrite={false} />
      <Edges color={highlight ? EDGE_COLOR[highlight] : '#b45309'} lineWidth={2} />
    </mesh>
  );
}
