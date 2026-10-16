import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import {
  createLinePlayer,
  nodeGeometry,
  palletSlot,
  placeUnits,
  poseAt,
  toolAt,
  type PlayState,
  type QueueView,
  type StationState,
} from '@sim/domain';
import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import {
  BoxGeometry,
  Color,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Vector3,
} from 'three';
import type { AnimationData } from './animation';
import { STATE_COLOR, STATE_LABEL } from './format';

// Capas de la reproducción dentro del lienzo (mm, Z arriba). Las unidades y las cajas de los
// pallets se dibujan con InstancedMesh y se actualizan en cada cuadro sin pasar por React.

const MAX_UNITS = 2000;
const PRODUCT_COLOR = new Color('#d97706');
const COMPONENT_COLOR = new Color('#38bdf8');
const LOAD_COLOR = new Color('#b45309');

export function AnimationLayer({
  data,
  tRef,
  onFrame,
}: {
  data: AnimationData;
  tRef: MutableRefObject<number>;
  /** Recibe el estado de cada cuadro (para los contadores en pantalla). */
  onFrame: (state: PlayState) => void;
}) {
  const playerRef = useRef<{ data: AnimationData; seek: (t: number) => PlayState } | null>(null);
  const units = useRef<InstancedMesh>(null);
  const loads = useRef<InstancedMesh>(null);
  const geometry = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const unitMat = useMemo(() => new MeshStandardMaterial({ roughness: 0.6 }), []);
  const loadMat = useMemo(() => new MeshStandardMaterial({ roughness: 0.7 }), []);
  const tmpRef = useRef(new Object3D());
  const product = data.scene.process.product.name;

  useEffect(
    () => () => {
      geometry.dispose();
      unitMat.dispose();
      loadMat.dispose();
    },
    [geometry, unitMat, loadMat],
  );

  useFrame(() => {
    if (playerRef.current?.data !== data)
      playerRef.current = { data, seek: createLinePlayer(data.tl).seek };
    const tmp = tmpRef.current;
    const state = playerRef.current.seek(tRef.current);
    onFrame(state);
    const placed = placeUnits(data.tl, state, data.handling);
    const um = units.current;
    if (um) {
      const n = Math.min(MAX_UNITS, placed.length);
      for (let i = 0; i < n; i++) {
        const u = placed[i]!;
        tmp.position.set(u.position[0], u.position[1], u.position[2] + u.size.height_mm / 2);
        tmp.rotation.set(0, 0, u.yaw);
        tmp.scale.set(u.size.length_mm, u.size.width_mm, u.size.height_mm);
        tmp.updateMatrix();
        um.setMatrixAt(i, tmp.matrix);
        const item = data.tl.items.get(u.id);
        um.setColorAt(i, !item || item === product ? PRODUCT_COLOR : COMPONENT_COLOR);
      }
      um.count = n;
      um.instanceMatrix.needsUpdate = true;
      if (um.instanceColor) um.instanceColor.needsUpdate = true;
    }
    const lm = loads.current;
    if (lm) {
      let k = 0;
      const size = data.tl.product;
      for (const [sink, pattern] of data.tl.pallets) {
        const fill = state.pallets.get(sink)?.fill ?? 0;
        const yaw = ((data.tl.objects.get(sink)?.rotation_deg ?? 0) * Math.PI) / 180;
        for (let s = 0; s < fill && k < MAX_UNITS; s++) {
          const p = palletSlot(data.tl, sink, s);
          if (!p) continue;
          tmp.position.set(p[0], p[1], p[2] + size.height_mm / 2);
          tmp.rotation.set(0, 0, yaw + (pattern.rotated ? Math.PI / 2 : 0));
          tmp.scale.set(size.length_mm * 0.97, size.width_mm * 0.97, size.height_mm * 0.97);
          tmp.updateMatrix();
          lm.setMatrixAt(k, tmp.matrix);
          lm.setColorAt(k, LOAD_COLOR);
          k++;
        }
      }
      lm.count = k;
      lm.instanceMatrix.needsUpdate = true;
      if (lm.instanceColor) lm.instanceColor.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh
        ref={units}
        args={[geometry, unitMat, MAX_UNITS]}
        castShadow
        frustumCulled={false}
      />
      <instancedMesh ref={loads} args={[geometry, loadMat, MAX_UNITS]} frustumCulled={false} />
    </>
  );
}

const LEVEL_STYLE: Record<QueueView['level'], string> = {
  ok: 'bg-white text-slate-700',
  warn: 'bg-amber-100 text-amber-900',
  full: 'bg-red-100 text-red-800',
};
const BAR_STYLE: Record<QueueView['level'], string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  full: 'bg-red-500',
};

/** Contadores, barras de llenado, pallets y mapa de calor (se actualizan ~10 veces/s). */
export function AnimationOverlays({
  data,
  ui,
  heat,
  hovered,
}: {
  data: AnimationData;
  ui: PlayState | null;
  heat: boolean;
  hovered: string | null;
}) {
  if (!ui) return null;
  const tl = data.tl;
  return (
    <>
      {[...tl.nodes.values()].map((n) => {
        const id = n.object_id;
        const g = nodeGeometry(tl, id);
        if (!g) return null;
        const q = ui.queues.get(id);
        const pallet = ui.pallets.get(id);
        const top = g.object.kind === 'robot' ? g.top[2] + 900 : g.top[2] + 350;
        const h = heat && ui.heatMax > 0 ? (ui.heat.get(id) ?? 0) / ui.heatMax : 0;
        const size = Math.max(600, g.length || 600) + 400;
        const w = Math.max(600, g.width || 600) + 400;
        const showQueue = q && (q.waiting > 0 || q.incoming > 0 || n.role === 'buffer');
        return (
          <group key={id}>
            {heat && h > 0.01 && (
              <mesh
                position={[g.object.position[0], g.object.position[1], 8]}
                rotation={[0, 0, g.yaw]}
              >
                <planeGeometry args={[size, w]} />
                <meshBasicMaterial
                  color={new Color().setHSL((1 - h) * 0.33, 0.85, 0.5)}
                  transparent
                  opacity={0.25 + 0.45 * h}
                  depthWrite={false}
                />
              </mesh>
            )}
            {(showQueue || pallet) && (
              <Html
                position={[g.top[0], g.top[1], top]}
                center
                style={{ pointerEvents: 'none' }}
                zIndexRange={[20, 0]}
              >
                <div
                  className={`min-w-16 rounded-lg px-1.5 py-1 text-center text-[10px] leading-tight font-semibold whitespace-nowrap shadow ${
                    pallet
                      ? pallet.changing
                        ? 'bg-amber-100 text-amber-900'
                        : 'bg-white text-slate-700'
                      : LEVEL_STYLE[q!.level]
                  }`}
                >
                  {pallet ? (
                    <>
                      {pallet.changing
                        ? 'Cambiando pallet'
                        : `${pallet.fill} / ${pallet.perPallet}`}
                      <div className="mt-0.5 h-1 overflow-hidden rounded bg-slate-200">
                        <div
                          className="h-full bg-amber-600"
                          style={{
                            width: `${pallet.perPallet ? (100 * pallet.fill) / pallet.perPallet : 0}%`,
                          }}
                        />
                      </div>
                    </>
                  ) : (
                    <>
                      {q!.waiting} en espera
                      {q!.incoming > 0 && (
                        <span className="block font-normal">{q!.incoming} por entrar</span>
                      )}
                      {q!.capacity != null && (
                        <div className="mt-0.5 h-1 overflow-hidden rounded bg-slate-200">
                          <div
                            className={`h-full ${BAR_STYLE[q!.level]}`}
                            style={{ width: `${Math.min(100, (q!.ratio ?? 0) * 100)}%` }}
                          />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </Html>
            )}
            {hovered === id && <Tooltip data={data} ui={ui} id={id} z={top + 400} />}
          </group>
        );
      })}
    </>
  );
}

function Tooltip({
  data,
  ui,
  id,
  z,
}: {
  data: AnimationData;
  ui: PlayState;
  id: string;
  z: number;
}) {
  const tl = data.tl;
  const n = tl.nodes.get(id)!;
  const o = tl.objects.get(id)!;
  const st = ui.states.get(id) as StationState | undefined;
  const q = ui.queues.get(id);
  const c = ui.counters.get(id);
  const pallet = ui.pallets.get(id);
  const plan = data.plans.get(id);
  const pose = plan ? poseAt(plan, ui.t) : null;
  const rows: [string, string][] = [];
  if (st) rows.push(['Estado', STATE_LABEL[st]]);
  if (q && n.role === 'station') rows.push(['En proceso', String(q.inProcess)]);
  if (q) rows.push(['En espera', `${q.waiting}${q.capacity != null ? ` de ${q.capacity}` : ''}`]);
  if (q?.incoming) rows.push(['Por entrar', String(q.incoming)]);
  if (c) rows.push(['Terminadas en la ventana', String(c.completed || c.arrived)]);
  if (pallet)
    rows.push(['Pallet', `${pallet.fill} de ${pallet.perPallet} · ${pallet.completed} completos`]);
  if (pose) {
    rows.push(['Robot', pose.phase]);
    rows.push(['Garra', pose.gripper === 'closed' ? 'cerrada' : 'abierta']);
  }
  rows.push(['Espera acumulada', `${Math.round(ui.heat.get(id) ?? 0)} u·s`]);
  return (
    <Html
      position={[o.position[0], o.position[1], z]}
      center
      style={{ pointerEvents: 'none' }}
      zIndexRange={[30, 0]}
    >
      <div className="w-52 rounded-xl border border-slate-200 bg-white/95 p-2 text-[11px] shadow-lg">
        <p className="mb-1 flex items-center gap-1.5 font-semibold text-slate-800">
          {st && <span className="h-2 w-2 rounded-full" style={{ background: STATE_COLOR[st] }} />}
          {o.name}
        </p>
        <dl className="space-y-0.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right text-slate-800 tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Html>
  );
}

/**
 * Cámara en la herramienta: tras el render normal, dibuja la escena desde el TCP del robot en
 * un recuadro (esquina superior derecha). Solo se monta si hay una cámara elegida.
 */
export function WristCameraView({
  data,
  tRef,
  robotId,
  root,
}: {
  data: AnimationData;
  tRef: MutableRefObject<number>;
  robotId: string;
  /** Grupo raíz que convierte mm (Z arriba) a metros (Y arriba). */
  root: MutableRefObject<Object3D | null>;
}) {
  const tmp = useRef({
    cam: new PerspectiveCamera(70, 4 / 3, 0.01, 100),
    m: new Matrix4(),
    eye: new Vector3(),
    look: new Vector3(),
    up: new Vector3(),
  });

  useFrame(({ gl, scene, camera, size }) => {
    const { cam, m, eye, look, up } = tmp.current;
    const plan = data.plans.get(robotId);
    const robot = data.tl.objects.get(robotId);
    gl.autoClear = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    gl.render(scene, camera);
    if (!plan || !robot || !root.current) return;
    // Pose del TCP en el mundo (mm, Z arriba) → coordenadas del lienzo con el grupo raíz.
    const tool = toolAt(plan, tRef.current);
    const yaw = (robot.rotation_deg * Math.PI) / 180;
    m.makeRotationZ(yaw).setPosition(robot.position[0], robot.position[1], robot.elevation);
    m.multiply(new Matrix4().fromArray(tool.matrix));
    root.current.updateMatrixWorld();
    const world = root.current.matrixWorld;
    // La cámara va a un costado de la herramienta (fuera de la pieza que lleva), un poco más
    // arriba, y mira hacia abajo en la dirección de la herramienta (-Z local).
    eye.set(-260, 0, 180).applyMatrix4(m).applyMatrix4(world);
    look.set(0, 0, -700).applyMatrix4(m).applyMatrix4(world);
    up.set(1, 0, 0).transformDirection(m).transformDirection(world);
    cam.position.copy(eye);
    cam.up.copy(up);
    cam.lookAt(look);
    const w = Math.round(Math.min(320, size.width * 0.38));
    const h = Math.round((w * 3) / 4);
    const x = size.width - w - 8;
    const y = size.height - h - 44;
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    gl.autoClear = false;
    gl.setScissorTest(true);
    gl.setScissor(x, y, w, h);
    gl.setViewport(x, y, w, h);
    gl.clear(true, true);
    gl.render(scene, cam);
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    gl.autoClear = true;
  }, 1);
  return null;
}
