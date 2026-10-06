import { Grid, OrbitControls } from '@react-three/drei';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { resolveJoints, type RobotModel, type Scene, type SceneObject } from '@sim/domain';
import { useRef, type ComponentRef } from 'react';
import { Plane, Vector3 } from 'three';
import { EnvelopeMesh, ObjectMesh, RobotMesh, type Highlight } from './meshes';
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

  const highlightOf = (id: string): Highlight =>
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
          const model = o.kind === 'robot' ? props.models[o.params.variant_slug] : undefined;
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
                    />
                    {o.params.show_envelope && <EnvelopeMesh model={model} />}
                  </>
                ) : (
                  <mesh position={[0, 0, 150]}>
                    <boxGeometry args={[300, 300, 300]} />
                    <meshStandardMaterial color="#cbd5e1" wireframe />
                  </mesh>
                )
              ) : (
                <ObjectMesh o={o} highlight={highlightOf(o.id)} />
              )}
            </group>
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
