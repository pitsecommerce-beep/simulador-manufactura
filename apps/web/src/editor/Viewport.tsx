import { Grid, Html, Line, OrbitControls } from '@react-three/drei';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import {
  ROLE_LABEL,
  footprint,
  isWorkObject,
  resolveJoints,
  type PlaybackFrame,
  type RobotModel,
  type Scene,
  type SceneObject,
} from '@sim/domain';
import { useRef, type ComponentRef } from 'react';
import { Plane, Vector3 } from 'three';
import {
  EnvelopeMesh,
  FenceMesh,
  GripperMesh,
  ObjectMesh,
  RobotMesh,
  SafetyZoneMesh,
  SensorMesh,
  type Highlight,
} from './meshes';
import { STATE_COLOR } from '../sim/format';
import { snap } from './sceneOps';

// El modelo usa mm con Z arriba; three.js usa Y arriba. Un grupo raíz convierte:
// (x, y, z) mm  ->  (x, z, -y) m.
const MM = 0.001;
const GROUND = new Plane(new Vector3(0, 1, 0), 0);

interface Props {
  scene: Scene;
  models: Record<string, RobotModel | undefined>;
  selectedId: string | null;
  warned: Set<string>;
  editable: boolean;
  snapMm: number;
  /** Muestra rutas del proceso y roles. */
  flowMode: boolean;
  /** Objeto desde el que se está trazando una ruta. */
  connectFrom: string | null;
  /** Reproducción de una corrida: estados de estación y unidades en movimiento. */
  playback?: PlaybackFrame | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: [number, number]) => void;
  onMoveEnd: () => void;
}

export default function Viewport(props: Props) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const drag = useRef<{ id: string; offset: [number, number] } | null>(null);
  const hit = useRef(new Vector3());

  const groundPoint = (e: ThreeEvent<PointerEvent>): [number, number] | null => {
    const p = e.ray.intersectPlane(GROUND, hit.current);
    return p ? [p.x / MM, -p.z / MM] : null;
  };

  function onDown(e: ThreeEvent<PointerEvent>, o: SceneObject) {
    e.stopPropagation();
    props.onSelect(o.id);
    if (!props.editable) return;
    const p = groundPoint(e);
    if (!p) return;
    drag.current = { id: o.id, offset: [o.position[0] - p[0], o.position[1] - p[1]] };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    if (controls.current) controls.current.enabled = false;
  }

  function onDragMove(e: ThreeEvent<PointerEvent>) {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const p = groundPoint(e);
    if (!p) return;
    props.onMove(d.id, [
      snap(p[0] + d.offset[0], props.snapMm),
      snap(p[1] + d.offset[1], props.snapMm),
    ]);
  }

  function onUp(e: ThreeEvent<PointerEvent>) {
    if (!drag.current) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    drag.current = null;
    if (controls.current) controls.current.enabled = true;
    props.onMoveEnd();
  }

  const byId = new Map(props.scene.objects.map((o) => [o.id, o]));
  const mountedOn = new Map<string, string>();
  const toolsByRobot = new Map<string, Extract<SceneObject, { kind: 'gripper' }>>();
  for (const o of props.scene.objects) {
    if (o.kind !== 'gripper' || !o.params.mounted_on) continue;
    const robot = byId.get(o.params.mounted_on);
    if (robot?.kind !== 'robot' || toolsByRobot.has(robot.id)) continue;
    mountedOn.set(o.id, robot.id);
    toolsByRobot.set(robot.id, o);
  }
  const roleOf = new Map(props.scene.process.nodes.map((n) => [n.object_id, n.role]));
  const topOf = (o: SceneObject) => {
    if (o.kind === 'robot') {
      const m = props.models[o.params.variant_slug];
      return m?.inverted ? 0 : (m?.base.height ?? 300);
    }
    return footprint(o)?.h ?? 50;
  };
  const anchor = (o: SceneObject): [number, number, number] => [
    o.position[0],
    o.position[1],
    o.elevation + topOf(o) + 250,
  ];

  const highlightOf = (id: string): Highlight => {
    if (props.playback) return props.playback.states.get(id) ?? null;
    return selectionHighlight(id);
  };
  const selectionHighlight = (id: string): Highlight =>
    id === props.selectedId ? 'selected' : props.warned.has(id) ? 'warning' : null;

  return (
    <Canvas
      shadows
      camera={{ position: [4, 4.5, 6], fov: 45, near: 0.05, far: 200 }}
      onPointerMissed={() => props.onSelect(null)}
      gl={{ preserveDrawingBuffer: true }}
    >
      <color attach="background" args={['#f1f5f9']} />
      <hemisphereLight args={['#ffffff', '#cbd5e1', 0.9]} />
      <directionalLight
        position={[6, 10, 4]}
        intensity={1.4}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <Grid
        args={[40, 40]}
        cellSize={0.1}
        cellThickness={0.5}
        cellColor="#cbd5e1"
        sectionSize={1}
        sectionThickness={1}
        sectionColor="#94a3b8"
        fadeDistance={35}
        infiniteGrid
      />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <shadowMaterial opacity={0.12} />
      </mesh>
      <group rotation={[-Math.PI / 2, 0, 0]} scale={MM}>
        {props.scene.objects.map((o) => {
          // Los grippers montados se dibujan en la brida de su robot.
          if (o.kind === 'gripper' && mountedOn.has(o.id)) return null;
          const model = o.kind === 'robot' ? props.models[o.params.variant_slug] : undefined;
          const tool = o.kind === 'robot' ? toolsByRobot.get(o.id) : undefined;
          return (
            <group
              key={o.id}
              position={[o.position[0], o.position[1], o.elevation]}
              rotation={[0, 0, (o.rotation_deg * Math.PI) / 180]}
              onPointerDown={(e) => onDown(e, o)}
              onPointerMove={onDragMove}
              onPointerUp={onUp}
            >
              {o.kind === 'robot' ? (
                model ? (
                  <>
                    <RobotMesh
                      model={model}
                      joints={resolveJoints(model, o.params.joints)}
                      color={o.color}
                      highlight={highlightOf(o.id)}
                      tool={
                        tool && (
                          <group
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              props.onSelect(tool.id);
                            }}
                          >
                            <GripperMesh color={tool.color} highlight={highlightOf(tool.id)} />
                          </group>
                        )
                      }
                    />
                    {o.params.show_envelope && <EnvelopeMesh model={model} />}
                  </>
                ) : (
                  <mesh position={[0, 0, 150]}>
                    <boxGeometry args={[300, 300, 300]} />
                    <meshStandardMaterial color="#cbd5e1" wireframe />
                  </mesh>
                )
              ) : isWorkObject(o) ? (
                <ObjectMesh o={o} highlight={highlightOf(o.id)} />
              ) : o.kind === 'gripper' ? (
                <group position={[0, 0, footprint(o)?.h ?? 0]}>
                  <GripperMesh color={o.color} highlight={highlightOf(o.id)} />
                </group>
              ) : o.kind === 'sensor' ? (
                <SensorMesh color={o.color} highlight={highlightOf(o.id)} />
              ) : o.kind === 'fence' ? (
                <FenceMesh o={o} highlight={highlightOf(o.id)} />
              ) : (
                <SafetyZoneMesh o={o} highlight={highlightOf(o.id)} />
              )}
              {props.flowMode && roleOf.get(o.id) && (
                <Html
                  position={[0, 0, topOf(o) + 120]}
                  center
                  style={{ pointerEvents: 'none' }}
                  zIndexRange={[10, 0]}
                >
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap shadow-sm ${
                      o.id === props.connectFrom
                        ? 'bg-brand-600 text-white'
                        : 'bg-white text-slate-700'
                    }`}
                  >
                    {ROLE_LABEL[roleOf.get(o.id)!]}
                  </span>
                </Html>
              )}
            </group>
          );
        })}
        {props.playback &&
          props.scene.objects.map((o) => {
            const st = props.playback!.states.get(o.id);
            if (!st) return null;
            const f = footprint(o);
            const r =
              o.kind === 'robot'
                ? (props.models[o.params.variant_slug]?.base.radius ?? 150) * 2
                : 0;
            const l = f ? f.l + 300 : r * 2;
            const w = f ? f.w + 300 : r * 2;
            return (
              <mesh
                key={`halo-${o.id}`}
                position={[o.position[0], o.position[1], 6]}
                rotation={[0, 0, (o.rotation_deg * Math.PI) / 180]}
              >
                <boxGeometry args={[l, w, 6]} />
                <meshBasicMaterial
                  color={STATE_COLOR[st]}
                  transparent
                  opacity={0.45}
                  depthWrite={false}
                />
              </mesh>
            );
          })}
        {props.playback &&
          [...props.playback.units].map(([unit, [prev, node, f]]) => {
            const to = byId.get(node);
            if (!to) return null;
            const b = anchor(to);
            const from = prev ? byId.get(prev) : undefined;
            const a = from ? anchor(from) : b;
            const p: [number, number, number] = [
              a[0] + (b[0] - a[0]) * f,
              a[1] + (b[1] - a[1]) * f,
              a[2] + (b[2] - a[2]) * f - 150,
            ];
            return (
              <mesh key={unit} position={p}>
                <boxGeometry args={[160, 160, 160]} />
                <meshStandardMaterial color="#7c3aed" />
              </mesh>
            );
          })}
        {props.flowMode &&
          props.scene.process.routes.map((r) => {
            const a = byId.get(r.from);
            const b = byId.get(r.to);
            if (!a || !b) return null;
            return (
              <RouteArrow
                key={r.id}
                from={anchor(a)}
                to={anchor(b)}
                label={r.item ?? (r.share != null ? `${Math.round(r.share * 100)} %` : null)}
              />
            );
          })}
      </group>
      <OrbitControls
        ref={controls}
        makeDefault
        maxPolarAngle={Math.PI / 2 - 0.05}
        target={[0, 0.3, 1]}
      />
    </Canvas>
  );
}

/** Flecha de una ruta del proceso (mm, Z arriba). */
function RouteArrow({
  from,
  to,
  label,
}: {
  from: [number, number, number];
  to: [number, number, number];
  label: string | null;
}) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  // La punta queda un poco antes del destino para no taparlo.
  const back = Math.min(220, len * 0.3);
  const tip: [number, number, number] = [
    to[0] - (dx / len) * back,
    to[1] - (dy / len) * back,
    to[2] - (dz / len) * back,
  ];
  const yaw = Math.atan2(dy, dx);
  const pitch = Math.atan2(dz, Math.hypot(dx, dy));
  return (
    <group>
      <Line points={[from, tip]} color="#7c3aed" lineWidth={4} />
      <group position={tip} rotation={[0, -pitch, yaw, 'ZYX']}>
        {/* El cono de three apunta a +Y; se gira para que apunte a +X. */}
        <mesh rotation={[0, 0, -Math.PI / 2]}>
          <coneGeometry args={[70, 220, 16]} />
          <meshBasicMaterial color="#7c3aed" />
        </mesh>
      </group>
      {label && (
        <Html
          position={[(from[0] + tip[0]) / 2, (from[1] + tip[1]) / 2, (from[2] + tip[2]) / 2 + 60]}
          center
          style={{ pointerEvents: 'none' }}
          zIndexRange={[10, 0]}
        >
          <span className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] text-white">
            {label}
          </span>
        </Html>
      )}
    </group>
  );
}
