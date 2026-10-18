import * as m4 from './mat4.ts';
import { palletPattern, type PalletPattern } from './palletizing.ts';
import { DEFAULT_PRODUCT_SIZE, distMean, type ProcessNode, type ProductSize } from './process.ts';
import type { Scene, SceneObject } from './scene.ts';
import type { EventLog, StationState } from './simulation.ts';
import type { Vec3 } from './validate.ts';

// Reproducción de la operación (PLAN 24.3 a 24.5). A partir del registro de eventos de una
// réplica y de la escena simulada: dónde está cada unidad, qué se acumula en cada nodo, cómo
// se llenan los pallets y el tiempo de espera acumulado (mapa de calor).

const DEG = Math.PI / 180;

/** Velocidad de banda supuesta si el buffer no tiene tiempo de recorrido (mm/s). */
export const DEFAULT_CONVEYOR_SPEED_MM_S = 300;
/** Duración visual de un traslado entre objetos sin robot (s de simulación). */
export const HANDOFF_S = 1.5;
/** Escala de dibujo de los componentes de la BOM respecto al producto. */
export const COMPONENT_SCALE = 0.6;
/** Separación entre unidades en filas (fracción de su largo). */
const GAP = 1.1;

// ---------------------------------------------------------------------------
// Línea de tiempo precalculada
// ---------------------------------------------------------------------------

export interface Visit {
  unit: number;
  node: string;
  tAt: number;
  /** Fin del ciclo en una estación (evento `done` o estimado con la media en registros v1). */
  tDone: number | null;
  /** Cuando sale del nodo (llega al siguiente o desaparece). */
  tLeave: number | null;
  /** Nodo siguiente (null si desaparece o la ventana termina). */
  next: string | null;
  prev: string | null;
  /** Posición en el patrón del pallet (salidas sobre pallet). */
  slot: number | null;
}

export interface LineTimeline {
  log: EventLog;
  scene: Scene;
  version: number;
  nodes: Map<string, ProcessNode>;
  objects: Map<string, SceneObject>;
  succ: Map<string, string[]>;
  pred: Map<string, string[]>;
  visitsByNode: Map<string, Visit[]>;
  visitsByUnit: Map<number, Visit[]>;
  /** Artículo de cada unidad (para dibujar componentes más chicos). */
  items: Map<number, string>;
  product: ProductSize;
  /** El tamaño del producto es un supuesto visual (no está en la escena). */
  productAssumed: boolean;
  pallets: Map<string, PalletPattern>;
}

const sizeOf = (s: Scene): ProductSize => s.process.product.size_mm ?? DEFAULT_PRODUCT_SIZE;

export function buildTimeline(log: EventLog, scene: Scene): LineTimeline {
  const nodes = new Map(scene.process.nodes.map((n) => [n.object_id, n]));
  const objects = new Map(scene.objects.map((o) => [o.id, o]));
  const succ = new Map<string, string[]>();
  const pred = new Map<string, string[]>();
  for (const r of scene.process.routes) {
    succ.set(r.from, [...(succ.get(r.from) ?? []), r.to]);
    pred.set(r.to, [...(pred.get(r.to) ?? []), r.from]);
  }
  const version = log.version ?? 1;
  const product = sizeOf(scene);
  const visitsByNode = new Map<string, Visit[]>();
  const visitsByUnit = new Map<number, Visit[]>();
  const items = new Map<number, string>();
  const current = new Map<number, Visit>();
  const pendingSlot = new Map<string, Visit[]>();
  const fillV1 = new Map<string, number>();

  const close = (v: Visit, t: number, next: string | null) => {
    v.tLeave = t;
    v.next = next;
  };
  for (const e of log.events) {
    const t = e[0];
    if (e[1] === 'at') {
      const [, , unit, node] = e;
      const cur = current.get(unit);
      if (cur?.node === node) continue; // foto inicial repetida
      if (cur) close(cur, t, node);
      const v: Visit = {
        unit,
        node,
        tAt: t,
        tDone: null,
        tLeave: null,
        next: null,
        prev: cur?.node ?? null,
        slot: null,
      };
      current.set(unit, v);
      visitsByNode.set(node, [...(visitsByNode.get(node) ?? []), v]);
      visitsByUnit.set(unit, [...(visitsByUnit.get(unit) ?? []), v]);
      const n = nodes.get(node);
      if (n?.role === 'source' && n.item) items.set(unit, n.item);
      if (n?.role === 'sink') {
        if (version >= 2) pendingSlot.set(node, [...(pendingSlot.get(node) ?? []), v]);
        else {
          const per = n.units_per_pallet ?? 1;
          const k = fillV1.get(node) ?? 0;
          v.slot = k % per;
          fillV1.set(node, k + 1);
        }
      }
    } else if (e[1] === 'done') {
      const cur = current.get(e[2]);
      if (cur && cur.node === e[3]) cur.tDone = t;
    } else if (e[1] === 'gone') {
      const cur = current.get(e[2]);
      if (cur) close(cur, t, null);
      current.delete(e[2]);
    } else if (e[1] === 'pal') {
      const queue = pendingSlot.get(e[2]);
      const v = queue?.shift();
      if (v && e[3] > 0) v.slot = e[3] - 1;
    }
  }
  // Registros v1: el fin de ciclo se estima con la media del ciclo de la estación.
  for (const [id, list] of visitsByNode) {
    const n = nodes.get(id);
    if (n?.role !== 'station') continue;
    const mean = n.cycle ? distMean(n.cycle.dist) : 0;
    for (const v of list)
      if (v.tDone == null && version < 2)
        v.tDone = v.tLeave != null ? Math.min(v.tLeave, v.tAt + mean) : v.tAt + mean;
  }
  // Las unidades de ensamblaje que nacen en la estación toman el nombre del producto.
  for (const n of nodes.values())
    if (n.role === 'station' && n.operation === 'assemble')
      for (const v of visitsByNode.get(n.object_id) ?? [])
        if (!items.has(v.unit)) items.set(v.unit, scene.process.product.name);
  // Propaga el artículo a lo largo de las visitas.
  for (const [u, vs] of visitsByUnit) {
    if (items.has(u)) continue;
    const first = nodes.get(vs[0]!.node);
    if (first?.role === 'source' && first.item) items.set(u, first.item);
  }

  const pallets = new Map<string, PalletPattern>();
  for (const n of nodes.values()) {
    const o = objects.get(n.object_id);
    if (n.role === 'sink' && o?.kind === 'pallet')
      pallets.set(n.object_id, palletPattern(o.params, product, n.units_per_pallet ?? 1));
  }
  return {
    log,
    scene,
    version,
    nodes,
    objects,
    succ,
    pred,
    visitsByNode,
    visitsByUnit,
    items,
    product,
    productAssumed: scene.process.product.size_mm == null,
    pallets,
  };
}

// ---------------------------------------------------------------------------
// Estado en un instante
// ---------------------------------------------------------------------------

export interface UnitState {
  id: number;
  node: string;
  prev: string | null;
  tAt: number;
  done: boolean;
}

export type QueueLevel = 'ok' | 'warn' | 'full';

export interface QueueView {
  /** Unidades que esperan en el nodo (buffer y fuente: todas; estación: terminadas sin salir). */
  waiting: number;
  /** Unidades en proceso (estaciones). */
  inProcess: number;
  /** Unidades que esperan en el nodo anterior para entrar a este. */
  incoming: number;
  capacity: number | null;
  ratio: number | null;
  level: QueueLevel;
}

export interface PalletView {
  /** Unidades en el pallet que se ve (durante el cambio, el pallet lleno que se retira). */
  fill: number;
  perPallet: number;
  changing: boolean;
  completed: number;
}

export interface NodeCounters {
  arrived: number;
  completed: number;
}

export interface PlayState {
  t: number;
  states: Map<string, StationState>;
  units: Map<number, UnitState>;
  queues: Map<string, QueueView>;
  pallets: Map<string, PalletView>;
  /** Tiempo de espera acumulado (unidades × s) desde el inicio de la ventana. */
  heat: Map<string, number>;
  heatMax: number;
  counters: Map<string, NodeCounters>;
}

export const levelOf = (ratio: number | null): QueueLevel =>
  ratio == null ? 'ok' : ratio >= 1 ? 'full' : ratio >= 0.8 ? 'warn' : 'ok';

/**
 * Reproductor incremental: avanzar aplica solo los eventos nuevos; retroceder vuelve a
 * empezar desde el inicio del registro.
 */
export function createLinePlayer(tl: LineTimeline) {
  const events = tl.log.events;
  let cursor = 0;
  let lastT = -Infinity;
  let units = new Map<number, UnitState>();
  let states = new Map<string, StationState>();
  let fills = new Map<string, number>();
  let changing = new Set<string>();
  let completedPallets = new Map<string, number>();
  let waiting = new Map<string, number>();
  let heat = new Map<string, number>();
  let since = new Map<string, number>();
  let counters = new Map<string, NodeCounters>();

  const reset = () => {
    cursor = 0;
    units = new Map();
    states = new Map();
    fills = new Map();
    changing = new Set();
    completedPallets = new Map();
    waiting = new Map();
    heat = new Map();
    since = new Map();
    counters = new Map();
  };

  const counts = (u: UnitState) => {
    const role = tl.nodes.get(u.node)?.role;
    return role === 'source' || role === 'buffer' || (role === 'station' && u.done);
  };
  const bump = (node: string, delta: number, t: number) => {
    const w = waiting.get(node) ?? 0;
    heat.set(node, (heat.get(node) ?? 0) + w * (t - (since.get(node) ?? t)));
    since.set(node, t);
    waiting.set(node, w + delta);
  };
  const counter = (node: string) => {
    let c = counters.get(node);
    if (!c) counters.set(node, (c = { arrived: 0, completed: 0 }));
    return c;
  };
  const leave = (u: UnitState, t: number) => {
    if (counts(u)) bump(u.node, -1, t);
  };
  const enter = (u: UnitState, t: number) => {
    if (counts(u)) bump(u.node, 1, t);
  };
  const isSnapshot = (t: number) => t === tl.log.start_s;

  function apply(e: (typeof events)[number]) {
    const t = e[0];
    switch (e[1]) {
      case 'st':
        states.set(e[2], e[3]);
        break;
      case 'at': {
        const prev = units.get(e[2]);
        if (prev?.node === e[3]) break;
        if (prev) leave(prev, t);
        const u: UnitState = {
          id: e[2],
          node: e[3],
          prev: prev?.node ?? null,
          tAt: t,
          done: false,
        };
        units.set(u.id, u);
        enter(u, t);
        if (!isSnapshot(t)) counter(u.node).arrived++;
        break;
      }
      case 'done': {
        const u = units.get(e[2]);
        if (!u || u.node !== e[3] || u.done) break;
        leave(u, t);
        u.done = true;
        enter(u, t);
        if (!isSnapshot(t)) counter(u.node).completed++;
        break;
      }
      case 'gone': {
        const u = units.get(e[2]);
        if (!u) break;
        leave(u, t);
        units.delete(e[2]);
        break;
      }
      case 'pal': {
        const per = tl.nodes.get(e[2]);
        const total = per?.role === 'sink' ? (per.units_per_pallet ?? 0) : 0;
        if (e[3] === total && total > 0 && !isSnapshot(t))
          completedPallets.set(e[2], (completedPallets.get(e[2]) ?? 0) + 1);
        fills.set(e[2], e[3] === total ? 0 : e[3]);
        break;
      }
      case 'pchg':
        if (e[3]) changing.add(e[2]);
        else changing.delete(e[2]);
        break;
    }
  }

  function seek(t: number): PlayState {
    if (t < lastT) reset();
    lastT = t;
    while (cursor < events.length && events[cursor]![0] <= t) apply(events[cursor++]!);
    if (tl.version < 2) {
      // Sin eventos `done`: una unidad en una estación termina con la media de su ciclo.
      for (const u of units.values()) {
        if (u.done || tl.nodes.get(u.node)?.role !== 'station') continue;
        const v = tl.visitsByUnit.get(u.id)?.find((x) => x.node === u.node && x.tAt === u.tAt);
        if (v?.tDone != null && v.tDone <= t) {
          leave(u, v.tDone);
          u.done = true;
          enter(u, v.tDone);
        }
      }
    }
    return snapshot(t);
  }

  function snapshot(t: number): PlayState {
    const queues = new Map<string, QueueView>();
    const inProcess = new Map<string, number>();
    for (const u of units.values())
      if (!u.done && tl.nodes.get(u.node)?.role === 'station')
        inProcess.set(u.node, (inProcess.get(u.node) ?? 0) + 1);
    const incoming = new Map<string, number>();
    for (const [node, w] of waiting) {
      const next = tl.succ.get(node);
      if (w > 0 && next?.length === 1) incoming.set(next[0]!, (incoming.get(next[0]!) ?? 0) + w);
    }
    for (const n of tl.nodes.values()) {
      const id = n.object_id;
      const w = waiting.get(id) ?? 0;
      const capacity = n.role === 'buffer' ? n.capacity : n.role === 'station' ? n.capacity : null;
      const ratio = capacity ? w / capacity : null;
      queues.set(id, {
        waiting: w,
        inProcess: inProcess.get(id) ?? 0,
        incoming: incoming.get(id) ?? 0,
        capacity,
        ratio,
        level: levelOf(ratio),
      });
    }
    const pallets = new Map<string, PalletView>();
    for (const n of tl.nodes.values()) {
      if (n.role !== 'sink') continue;
      const per = n.units_per_pallet ?? 0;
      let fill = fills.get(n.object_id);
      if (fill == null && tl.version < 2) {
        // v1: llenado según las llegadas (desde el inicio de la ventana).
        const arrived = (tl.visitsByNode.get(n.object_id) ?? []).filter((v) => v.tAt <= t).length;
        fill = per ? arrived % per : 0;
      }
      const ch = changing.has(n.object_id);
      pallets.set(n.object_id, {
        fill: ch ? per : (fill ?? 0),
        perPallet: per,
        changing: ch,
        completed: completedPallets.get(n.object_id) ?? 0,
      });
    }
    const heatNow = new Map<string, number>();
    let heatMax = 0;
    for (const n of tl.nodes.values()) {
      const id = n.object_id;
      const h = (heat.get(id) ?? 0) + (waiting.get(id) ?? 0) * (t - (since.get(id) ?? t));
      heatNow.set(id, h);
      heatMax = Math.max(heatMax, h);
    }
    return {
      t,
      states: new Map(states),
      units: new Map([...units].map(([k, u]) => [k, { ...u }])),
      queues,
      pallets,
      heat: heatNow,
      heatMax,
      counters: new Map([...counters].map(([k, c]) => [k, { ...c }])),
    };
  }

  return { seek };
}

/** Estado en un instante, sin reproductor incremental (para tests y consultas sueltas). */
export const lineStateAt = (tl: LineTimeline, t: number) => createLinePlayer(tl).seek(t);

// ---------------------------------------------------------------------------
// Geometría: dónde se apoyan las unidades en cada objeto
// ---------------------------------------------------------------------------

export interface NodeGeometry {
  object: SceneObject;
  /** Centro de la cara superior (mundo, mm). */
  top: Vec3;
  yaw: number;
  length: number;
  width: number;
  /** Bandas: dirección del flujo (unitaria, mundo) y extremos de entrada y salida. */
  dir: Vec3;
  entry: Vec3;
  exit: Vec3;
}

function dims(o: SceneObject): { l: number; w: number; h: number } | null {
  if (o.kind === 'pallet' || o.kind === 'box' || o.kind === 'table' || o.kind === 'conveyor')
    return { l: o.params.length_mm, w: o.params.width_mm, h: o.params.height_mm };
  return null;
}

const geoCache = new WeakMap<LineTimeline, Map<string, NodeGeometry | null>>();

/** Geometría de apoyo de un objeto del proceso (en caché por línea de tiempo). */
export function nodeGeometry(tl: LineTimeline, id: string): NodeGeometry | null {
  let cache = geoCache.get(tl);
  if (!cache) geoCache.set(tl, (cache = new Map()));
  if (!cache.has(id)) cache.set(id, computeGeometry(tl, id));
  return cache.get(id)!;
}

function computeGeometry(tl: LineTimeline, id: string): NodeGeometry | null {
  const o = tl.objects.get(id);
  if (!o) return null;
  const d = dims(o);
  const yaw = o.rotation_deg * DEG;
  const axis: Vec3 = [Math.cos(yaw), Math.sin(yaw), 0];
  const top: Vec3 = [o.position[0], o.position[1], o.elevation + (d?.h ?? 0)];
  let dir = axis;
  if (o.kind === 'conveyor') {
    // Sentido del flujo: entra por el extremo cercano al objeto anterior y sale por el
    // cercano al siguiente (por defecto, +X local).
    const center = (oid: string) => tl.objects.get(oid)?.position;
    const proj = (p: [number, number] | undefined) =>
      p ? (p[0] - o.position[0]) * axis[0] + (p[1] - o.position[1]) * axis[1] : 0;
    const before = (tl.pred.get(id) ?? []).map((p) => proj(center(p)));
    const after = (tl.succ.get(id) ?? []).map((p) => proj(center(p)));
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    if (avg(after) - avg(before) < 0) dir = m4.scale(axis, -1);
  }
  const half = (d?.l ?? 0) / 2;
  return {
    object: o,
    top,
    yaw: Math.atan2(dir[1], dir[0]),
    length: d?.l ?? 0,
    width: d?.w ?? 0,
    dir,
    entry: m4.sub(top, m4.scale(dir, half)),
    exit: m4.add(top, m4.scale(dir, half)),
  };
}

/** Medidas de dibujo de una unidad según su artículo. */
export function unitSize(tl: LineTimeline, unit: number): ProductSize {
  const item = tl.items.get(unit);
  if (!item || item === tl.scene.process.product.name) return tl.product;
  const p = tl.product;
  return {
    length_mm: p.length_mm * COMPONENT_SCALE,
    width_mm: p.width_mm * COMPONENT_SCALE,
    height_mm: p.height_mm * COMPONENT_SCALE,
  };
}

/** Posición k (0 = la del frente) en una fila que termina en `end` y avanza por `dir`. */
export function lineSlot(end: Vec3, dir: Vec3, k: number, size: ProductSize): Vec3 {
  return m4.sub(end, m4.scale(dir, (k + 0.5) * size.length_mm * GAP));
}

/** Posición k en una cuadrícula sobre la cara superior de un objeto (apila si no cabe). */
export function gridSlot(g: NodeGeometry, k: number, size: ProductSize): Vec3 {
  const pl = size.length_mm * GAP;
  const pw = size.width_mm * GAP;
  const nx = Math.max(1, Math.floor(g.length / pl));
  const ny = Math.max(1, Math.floor(g.width / pw));
  const per = nx * ny;
  const layer = Math.floor(k / per);
  const i = k % per;
  const lx = ((i % nx) - (nx - 1) / 2) * pl;
  const ly = (Math.floor(i / nx) - (ny - 1) / 2) * pw;
  const c = Math.cos(g.yaw);
  const s = Math.sin(g.yaw);
  return [
    g.top[0] + c * lx - s * ly,
    g.top[1] + s * lx + c * ly,
    g.top[2] + layer * size.height_mm,
  ];
}

/** Posición de la unidad `slot` del patrón de un pallet, en el mundo. */
export function palletSlot(tl: LineTimeline, sinkId: string, slot: number): Vec3 | null {
  const p = tl.pallets.get(sinkId);
  const g = nodeGeometry(tl, sinkId);
  if (!p || !g) return null;
  const local = p.slots[slot] ?? p.slots[p.slots.length - 1] ?? [0, 0, 0];
  const o = g.object;
  const yaw = o.rotation_deg * DEG;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [
    g.top[0] + c * local[0] - s * local[1],
    g.top[1] + s * local[0] + c * local[1],
    g.top[2] + local[2],
  ];
}

/** Dónde se recoge una unidad que sale del nodo `id` (frente de la fila o su cara superior). */
export function pickPoint(tl: LineTimeline, id: string, size: ProductSize): Vec3 | null {
  const g = nodeGeometry(tl, id);
  if (!g) return null;
  if (g.object.kind === 'conveyor') return lineSlot(g.exit, g.dir, 0, size);
  return gridSlot(g, 0, size);
}

/** Dónde se deja una unidad que entra al nodo `id` (pallet: su lugar en el patrón). */
export function dropPoint(
  tl: LineTimeline,
  id: string,
  size: ProductSize,
  slot: number | null,
): Vec3 | null {
  const g = nodeGeometry(tl, id);
  if (!g) return null;
  if (g.object.kind === 'pallet' && slot != null && tl.pallets.has(id))
    return palletSlot(tl, id, slot);
  if (g.object.kind === 'conveyor')
    return m4.add(g.entry, m4.scale(g.dir, size.length_mm * GAP * 0.5));
  return gridSlot(g, 0, size);
}

// ---------------------------------------------------------------------------
// Posición de las unidades
// ---------------------------------------------------------------------------

/** Giro (rad, mundo) de una unidad que se recoge en el nodo `id` (el largo sigue la banda). */
export function pickYaw(tl: LineTimeline, id: string): number {
  return nodeGeometry(tl, id)?.yaw ?? 0;
}

/** Giro (rad, mundo) de una unidad que se deja en el nodo `id` (pallet: giro del patrón). */
export function dropYaw(tl: LineTimeline, id: string): number {
  const g = nodeGeometry(tl, id);
  if (!g) return 0;
  const pattern = tl.pallets.get(id);
  if (g.object.kind === 'pallet' && pattern)
    return g.object.rotation_deg * DEG + (pattern.rotated ? Math.PI / 2 : 0);
  return g.yaw;
}

export interface PlacedUnit {
  id: number;
  /** Centro de la base de la unidad (mundo, mm). */
  position: Vec3;
  yaw: number;
  size: ProductSize;
  /** Robot que la lleva en la herramienta en este instante. */
  carriedBy: string | null;
  /**
   * El robot de su estación no anima este ciclo (fuera de alcance, ciclos simultáneos o sin
   * ficha): la unidad espera en la recogida y aparece en la entrega al terminar el ciclo.
   */
  unanimated: boolean;
}

/**
 * Qué hace el robot de una estación con una unidad en el instante t. La implementa el plan de
 * movimiento (`robot-motion.ts`). Sin plan para ese ciclo devuelve null: la unidad no se
 * traslada sola, queda en la recogida hasta el fin del ciclo y luego aparece en la entrega.
 */
export type RobotHandling = (
  robotId: string,
  unit: number,
  t: number,
) => { where: 'pick' | 'tool' | 'drop'; position?: Vec3; yaw?: number } | null;

export function placeUnits(
  tl: LineTimeline,
  state: PlayState,
  handling: RobotHandling = () => null,
): PlacedUnit[] {
  const t = state.t;
  const out: PlacedUnit[] = [];
  const byNode = new Map<string, UnitState[]>();
  for (const u of state.units.values()) byNode.set(u.node, [...(byNode.get(u.node) ?? []), u]);

  const visitOf = (u: UnitState) =>
    tl.visitsByUnit.get(u.id)?.find((v) => v.node === u.node && v.tAt === u.tAt);

  for (const [node, list] of byNode) {
    const n = tl.nodes.get(node);
    const g = nodeGeometry(tl, node);
    if (!n || !g) continue;
    const isRobot = g.object.kind === 'robot';
    // FIFO: la primera en llegar va al frente.
    list.sort((a, b) => a.tAt - b.tAt || a.id - b.id);
    let ahead = 0;
    let doneAhead = 0;
    for (const u of list) {
      const size = unitSize(tl, u.id);
      let pos: Vec3 | null;
      let carriedBy: string | null = null;
      let unanimated = false;
      let yaw = g.yaw;
      if (isRobot) {
        const visit = visitOf(u);
        const h = handling(node, u.id, t);
        const pick = u.prev ? pickPoint(tl, u.prev, size) : null;
        const drop = visit?.next
          ? dropPoint(tl, visit.next, size, slotFor(tl, u.id, visit.next))
          : null;
        let where = h?.where;
        if (!h && visit) {
          // Sin animación del robot: no hay traslado. Espera en la recogida hasta el fin del
          // ciclo y después aparece en la entrega.
          unanimated = true;
          const end = visit.tDone ?? visit.tLeave ?? Infinity;
          where = t < end || !drop ? 'pick' : 'drop';
        }
        if (h?.where === 'tool' && h.position) {
          pos = h.position;
          carriedBy = node;
        } else if (where === 'drop') pos = drop;
        else if (where === 'pick') pos = pick;
        else pos = pick ?? drop ?? [g.top[0], g.top[1], g.top[2]];
        if (h?.where === 'tool' && h.yaw != null) yaw = h.yaw;
        else if (where === 'drop' && visit?.next) yaw = dropYaw(tl, visit.next);
        else if (u.prev) yaw = pickYaw(tl, u.prev);
      } else if (g.object.kind === 'conveyor') {
        if (n.role === 'buffer') {
          const speed =
            n.transfer != null && distMean(n.transfer.dist) > 0
              ? g.length / distMean(n.transfer.dist)
              : DEFAULT_CONVEYOR_SPEED_MM_S;
          const pitch = size.length_mm * GAP;
          // Fila de acumulación: caben `lane` unidades; las demás se apilan en capas.
          const lane = Math.max(1, Math.floor(g.length / pitch));
          const layer = Math.floor(ahead / lane);
          const front = g.length - ((ahead % lane) + 0.5) * pitch;
          const travel = Math.max(0, (t - u.tAt) * speed);
          const along = layer ? front : Math.min(pitch / 2 + travel, front);
          pos = m4.add(g.entry, m4.scale(g.dir, along));
          if (layer) pos = [pos[0], pos[1], pos[2] + layer * size.height_mm];
          ahead++;
        } else if (n.role === 'station' && !u.done) {
          pos = g.top;
        } else {
          pos = lineSlot(g.exit, g.dir, n.role === 'station' ? doneAhead++ : ahead++, size);
        }
      } else if (n.role === 'station' && !u.done) {
        pos = g.top;
      } else {
        pos = gridSlot(g, n.role === 'station' ? doneAhead++ : ahead++, size);
      }

      // Traslado corto desde el objeto anterior (cuando no lo lleva un robot).
      const prevGeo = u.prev ? nodeGeometry(tl, u.prev) : null;
      if (!isRobot && prevGeo && prevGeo.object.kind !== 'robot' && t - u.tAt < HANDOFF_S && pos) {
        const from =
          prevGeo.object.kind === 'conveyor'
            ? lineSlot(prevGeo.exit, prevGeo.dir, 0, size)
            : prevGeo.top;
        pos = m4.lerp(from, pos, (t - u.tAt) / HANDOFF_S);
      }
      if (pos) out.push({ id: u.id, position: pos, yaw, size, carriedBy, unanimated });
    }
  }
  return out;
}

/** Lugar en el patrón del pallet que ocupará la unidad al llegar a la salida `sink`. */
export function slotFor(tl: LineTimeline, unit: number, sink: string): number | null {
  return tl.visitsByUnit.get(unit)?.find((v) => v.node === sink)?.slot ?? null;
}
