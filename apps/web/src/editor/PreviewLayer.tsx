import { Html, Line } from '@react-three/drei';
import { footprint, type RobotModel, type Scene, type SceneObject } from '@sim/domain';

// Vista previa de una propuesta del asistente: objetos semitransparentes con borde punteado
// violeta, superpuestos a la escena actual. Sin manejadores de eventos: no se seleccionan ni
// se arrastran (react-three-fiber solo prueba clics contra objetos con manejadores).

export const PREVIEW_COLOR = '#7c3aed';

type V3 = [number, number, number];

/** Caja punteada (mm, Z arriba) centrada en planta, de z0 a z0 + h. */
function DashedBox({ l, w, h }: { l: number; w: number; h: number }) {
  const x = l / 2;
  const y = w / 2;
  const ring = (z: number): V3[] => [
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
    [-x, -y, z],
  ];
  const posts: V3[][] = [
    [
      [-x, -y, 0],
      [-x, -y, h],
    ],
    [
      [x, -y, 0],
      [x, -y, h],
    ],
    [
      [x, y, 0],
      [x, y, h],
    ],
    [
      [-x, y, 0],
      [-x, y, h],
    ],
  ];
  const dash = { color: PREVIEW_COLOR, lineWidth: 2, dashed: true, dashSize: 60, gapSize: 40 };
  return (
    <>
      <mesh position={[0, 0, h / 2]}>
        <boxGeometry args={[l, w, Math.max(h, 1)]} />
        <meshBasicMaterial color={PREVIEW_COLOR} transparent opacity={0.18} depthWrite={false} />
      </mesh>
      <Line points={ring(0)} {...dash} />
      <Line points={ring(h)} {...dash} />
      {posts.map((p, i) => (
        <Line key={i} points={p} {...dash} />
      ))}
    </>
  );
}

function circle(r: number, z: number, n = 64): V3[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [Math.cos(a) * r, Math.sin(a) * r, z];
  });
}

function PreviewObject({ o, model }: { o: SceneObject; model: RobotModel | undefined }) {
  if (o.kind === 'robot') {
    const r = model?.base.radius ?? 150;
    const h = model?.base.height ?? 300;
    const z0 = model?.inverted ? -h : 0;
    return (
      <>
        <group position={[0, 0, z0]}>
          <DashedBox l={r * 2} w={r * 2} h={h} />
        </group>
        {model?.reach_mm != null && (
          <Line
            points={circle(model.reach_mm, -o.elevation + 4)}
            color={PREVIEW_COLOR}
            lineWidth={1.5}
            dashed
            dashSize={120}
            gapSize={80}
          />
        )}
        <Html
          position={[0, 0, h + 200]}
          center
          style={{ pointerEvents: 'none' }}
          zIndexRange={[10, 0]}
        >
          <span className="rounded-full bg-violet-600 px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-white shadow-sm">
            {o.name}
          </span>
        </Html>
      </>
    );
  }
  if (o.kind === 'safety_zone')
    return <DashedBox l={o.params.length_mm} w={o.params.width_mm} h={1} />;
  if (o.kind === 'gripper' && o.params.mounted_on) return null;
  const f = footprint(o);
  return f ? <DashedBox l={f.l} w={f.w} h={f.h} /> : null;
}

export function PreviewLayer({
  scene,
  models,
}: {
  scene: Scene;
  models: Record<string, RobotModel | undefined>;
}) {
  return (
    <>
      {scene.objects.map((o) => (
        <group
          key={`preview-${o.id}`}
          position={[o.position[0], o.position[1], o.elevation]}
          rotation={[0, 0, (o.rotation_deg * Math.PI) / 180]}
        >
          <PreviewObject
            o={o}
            model={o.kind === 'robot' ? models[o.params.variant_slug] : undefined}
          />
        </group>
      ))}
    </>
  );
}
