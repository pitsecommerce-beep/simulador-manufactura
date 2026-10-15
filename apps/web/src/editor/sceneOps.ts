import {
  PALLET_SIZES,
  ProcessNode,
  ROLES_BY_KIND,
  removeObjectFromProcess,
  type PalletPreset,
  type ProcessModel,
  type ProcessRole,
  type Route,
  type Scene,
  type SceneObject,
} from '@sim/domain';

// Operaciones puras sobre la escena del editor (probadas sin WebGL).

export const DEFAULT_COLORS: Record<SceneObject['kind'], string> = {
  robot: '#f97316',
  pallet: '#c08a4a',
  box: '#d6b58a',
  table: '#94a3b8',
  conveyor: '#475569',
  gripper: '#64748b',
  sensor: '#0ea5e9',
  fence: '#facc15',
  safety_zone: '#f59e0b',
};

/**
 * Medidas iniciales editables para objetos genéricos. No son datos de ficha: el usuario las
 * ajusta a su línea.
 */
export const STARTER_DIMS = {
  box: { length_mm: 400, width_mm: 300, height_mm: 250 },
  table: { length_mm: 1200, width_mm: 800, height_mm: 750 },
  conveyor: { length_mm: 2000, width_mm: 500, height_mm: 800 },
  fence: { length_mm: 2000, height_mm: 2000, thickness_mm: 50 },
  safety_zone: { length_mm: 1500, width_mm: 1500 },
} as const;

export const KIND_LABEL: Record<SceneObject['kind'], string> = {
  robot: 'Robot',
  pallet: 'Pallet',
  box: 'Caja',
  table: 'Mesa',
  conveyor: 'Banda',
  gripper: 'Gripper',
  sensor: 'Sensor',
  fence: 'Valla',
  safety_zone: 'Zona de seguridad',
};

export function newId(): string {
  return globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10);
}

/** Nombre libre del tipo "Caja 3". */
export function nextName(scene: Scene, base: string): string {
  const used = new Set(scene.objects.map((o) => o.name));
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Posición inicial que no cae encima de los objetos ya colocados. */
export function nextPosition(scene: Scene): [number, number] {
  const n = scene.objects.length;
  return [((n % 5) - 2) * 1500, 1500 + Math.floor(n / 5) * 1500];
}

export type NewObject =
  | { kind: 'robot'; variant_slug: string; label: string }
  | {
      kind: 'pallet';
      preset: PalletPreset;
      length_mm: number;
      width_mm: number;
      height_mm: number;
    }
  | { kind: 'box' | 'table' | 'conveyor' | 'fence' | 'safety_zone' }
  | {
      kind: 'gripper' | 'sensor';
      component_slug: string | null;
      label: string;
      mounted_on?: string | null;
    };

export function addObject(scene: Scene, spec: NewObject): { scene: Scene; id: string } {
  const id = newId();
  const base = {
    id,
    position: nextPosition(scene),
    elevation: 0,
    rotation_deg: 0,
    color: DEFAULT_COLORS[spec.kind],
    served_by: null,
  };
  let obj: SceneObject;
  if (spec.kind === 'robot') {
    obj = {
      ...base,
      kind: 'robot',
      name: nextName(scene, spec.label),
      params: { variant_slug: spec.variant_slug, joints: [], show_envelope: true },
    };
  } else if (spec.kind === 'pallet') {
    const { preset, length_mm, width_mm, height_mm } = spec;
    obj = {
      ...base,
      kind: 'pallet',
      name: nextName(scene, 'Pallet'),
      params: { preset, length_mm, width_mm, height_mm },
    };
  } else if (spec.kind === 'box') {
    obj = {
      ...base,
      kind: 'box',
      name: nextName(scene, 'Caja'),
      params: { ...STARTER_DIMS.box, mass_kg: null },
    };
  } else if (spec.kind === 'gripper') {
    const robot = scene.objects.find((o) => o.id === spec.mounted_on && o.kind === 'robot');
    obj = {
      ...base,
      position: robot ? robot.position : base.position,
      kind: 'gripper',
      name: nextName(scene, spec.label),
      params: { component_slug: spec.component_slug, mounted_on: robot?.id ?? null },
    };
  } else if (spec.kind === 'sensor') {
    obj = {
      ...base,
      elevation: 0,
      kind: 'sensor',
      name: nextName(scene, spec.label),
      params: { component_slug: spec.component_slug },
    };
  } else if (spec.kind === 'fence') {
    obj = {
      ...base,
      kind: 'fence',
      name: nextName(scene, 'Valla'),
      params: { ...STARTER_DIMS.fence, component_slug: null },
    };
  } else if (spec.kind === 'safety_zone') {
    obj = {
      ...base,
      kind: 'safety_zone',
      name: nextName(scene, 'Zona de seguridad'),
      params: { ...STARTER_DIMS.safety_zone },
    };
  } else {
    obj = {
      ...base,
      kind: spec.kind,
      name: nextName(scene, KIND_LABEL[spec.kind]),
      params: { ...STARTER_DIMS[spec.kind] },
    } as SceneObject;
  }
  return { scene: { ...scene, objects: [...scene.objects, obj] }, id };
}

export function updateObject(
  scene: Scene,
  id: string,
  patch: (o: SceneObject) => SceneObject,
): Scene {
  return { ...scene, objects: scene.objects.map((o) => (o.id === id ? patch(o) : o)) };
}

/**
 * Quita el objeto, las referencias "atendido por" que apuntaban a él, su nodo de proceso y
 * sus rutas. Los grippers montados en un robot borrado quedan sueltos en su posición.
 */
export function removeObject(scene: Scene, id: string): Scene {
  return {
    ...scene,
    objects: scene.objects
      .filter((o) => o.id !== id)
      .map((o) => {
        let next = o.served_by === id ? { ...o, served_by: null } : o;
        if (next.kind === 'gripper' && next.params.mounted_on === id) {
          next = { ...next, params: { ...next.params, mounted_on: null } };
        }
        return next;
      }),
    process: removeObjectFromProcess(scene.process, id),
  };
}

export function duplicateObject(scene: Scene, id: string): { scene: Scene; id: string | null } {
  const src = scene.objects.find((o) => o.id === id);
  if (!src) return { scene, id: null };
  const copy = {
    ...structuredClone(src),
    id: newId(),
    name: nextName(scene, src.name.replace(/\s\d+$/, '')),
    position: [src.position[0] + 300, src.position[1] + 300] as [number, number],
  };
  return { scene: { ...scene, objects: [...scene.objects, copy] }, id: copy.id };
}

/**
 * Medidas de un pallet según el preset. La altura solo viene del preset si está publicada;
 * si no, se devuelve null y el usuario debe capturarla.
 */
export function palletPreset(preset: PalletPreset) {
  if (preset === 'custom') return { length_mm: null, width_mm: null, height_mm: null };
  const p = PALLET_SIZES[preset];
  return { length_mm: p.length_mm, width_mm: p.width_mm, height_mm: p.height_mm };
}

/** Ayuda visible en el campo de altura. No se guarda como dato. */
export const PALLET_HEIGHT_HINT = `EUR publicado: ${PALLET_SIZES.eur.height_mm} mm`;

/** Ajusta un valor a la cuadrícula (mm). */
export const snap = (v: number, step: number) => (step > 0 ? Math.round(v / step) * step : v);

// ---------------------------------------------------------------------------
// Proceso
// ---------------------------------------------------------------------------

export const rolesFor = (o: SceneObject): ProcessRole[] => ROLES_BY_KIND[o.kind] ?? [];

const withProcess = (scene: Scene, fn: (p: ProcessModel) => ProcessModel): Scene => ({
  ...scene,
  process: fn(scene.process),
});

/**
 * Asigna (o quita, con null) el rol de un objeto en el proceso. Los parámetros obligatorios
 * empiezan vacíos: no hay tiempos por defecto.
 */
export function setRole(scene: Scene, objectId: string, role: ProcessRole | null): Scene {
  return withProcess(scene, (p) => {
    if (!role) return removeObjectFromProcess(p, objectId);
    const nodes = p.nodes.filter((n) => n.object_id !== objectId);
    const node = ProcessNode.parse({
      role,
      object_id: objectId,
      ...(role === 'source' ? { item: p.product.bom.length ? null : p.product.name } : {}),
    });
    // Las rutas que ya no tienen sentido para el nuevo rol se eliminan.
    const routes = p.routes.filter(
      (r) => !(role === 'sink' && r.from === objectId) && !(role === 'source' && r.to === objectId),
    );
    return { ...p, nodes: [...nodes, node], routes };
  });
}

export function updateNode(
  scene: Scene,
  objectId: string,
  fn: (n: ProcessNode) => ProcessNode,
): Scene {
  return withProcess(scene, (p) => ({
    ...p,
    nodes: p.nodes.map((n) => (n.object_id === objectId ? fn(n) : n)),
  }));
}

/** Agrega una ruta si ambos objetos tienen rol y la ruta no existe. Devuelve null si no aplica. */
export function addRoute(scene: Scene, from: string, to: string): Scene | null {
  const p = scene.process;
  if (from === to) return null;
  const a = p.nodes.find((n) => n.object_id === from);
  const b = p.nodes.find((n) => n.object_id === to);
  if (!a || !b || a.role === 'sink' || b.role === 'source') return null;
  if (p.routes.some((r) => r.from === from && r.to === to && r.item == null)) return null;
  const route: Route = { id: newId(), from, to, item: null, share: null };
  return withProcess(scene, (q) => ({ ...q, routes: [...q.routes, route] }));
}

export function updateRoute(scene: Scene, id: string, patch: Partial<Route>): Scene {
  return withProcess(scene, (p) => ({
    ...p,
    routes: p.routes.map((r) => (r.id === id ? { ...r, ...patch } : r)),
  }));
}

export function removeRoute(scene: Scene, id: string): Scene {
  return withProcess(scene, (p) => ({ ...p, routes: p.routes.filter((r) => r.id !== id) }));
}
