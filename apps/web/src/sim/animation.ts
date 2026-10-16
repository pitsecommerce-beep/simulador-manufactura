import {
  buildMotionPlan,
  buildTimeline,
  gripperKind,
  robotHandling,
  sampleTelemetry,
  simplifiedVisual,
  type CatalogComponent,
  type EventLog,
  type GripperKind,
  type LineTimeline,
  type MotionPlan,
  type RobotHandling,
  type RobotModel,
  type RobotTelemetry,
  type RobotVisual,
  type Scene,
} from '@sim/domain';

/** Aviso que acompaña siempre a la reproducción (PLAN 24). */
export const REPRESENTATIVE_NOTICE =
  'Animación representativa construida con los eventos de la réplica: no es la trayectoria real del robot.';

export interface AnimationData {
  tl: LineTimeline;
  scene: Scene;
  /** Un RobotVisual propio de la animación por robot (no se comparte con el editor). */
  visuals: Map<string, RobotVisual>;
  models: Map<string, RobotModel>;
  plans: Map<string, MotionPlan>;
  handling: RobotHandling;
  gripper: Map<string, GripperKind>;
  warnings: string[];
  /** Telemetría por robot, calculada al pedirla (es determinista). */
  telemetry(robotId: string): RobotTelemetry | null;
}

/**
 * Prepara la animación de una corrida: la escena simulada (foto guardada en la corrida), el
 * registro de eventos y el modelo de cada robot del catálogo.
 */
export function buildAnimation(
  scene: Scene,
  log: EventLog,
  modelFor: (variantSlug: string) => RobotModel | undefined,
  components: Map<string, CatalogComponent>,
): AnimationData {
  const tl = buildTimeline(log, scene);
  const visuals = new Map<string, RobotVisual>();
  const models = new Map<string, RobotModel>();
  const plans = new Map<string, MotionPlan>();
  const gripper = new Map<string, GripperKind>();
  const warnings: string[] = [];
  for (const o of scene.objects) {
    if (o.kind !== 'robot') continue;
    const model = modelFor(o.params.variant_slug);
    if (!model) continue;
    const visual = simplifiedVisual(model);
    visual.setJointValues(o.params.joints);
    visuals.set(o.id, visual);
    models.set(o.id, model);
    const tool = scene.objects.find((g) => g.kind === 'gripper' && g.params.mounted_on === o.id);
    const slug = tool?.kind === 'gripper' ? tool.params.component_slug : null;
    gripper.set(o.id, gripperKind(slug ? components.get(slug)?.type : null));
    if (tl.nodes.get(o.id)?.role === 'station') {
      const plan = buildMotionPlan(tl, o.id, visual);
      plans.set(o.id, plan);
      warnings.push(...plan.warnings);
    }
  }
  if (tl.productAssumed)
    warnings.push(
      'El producto no tiene medidas: las unidades se dibujan de 300 × 200 × 200 mm (supuesto visual).',
    );
  const missing = scene.objects.filter((o) => o.kind === 'robot' && !models.has(o.id));
  if (missing.length)
    warnings.push(`Sin ficha cargada para ${missing.map((o) => o.name).join(', ')}: no se anima.`);

  const cache = new Map<string, RobotTelemetry | null>();
  return {
    tl,
    scene,
    visuals,
    models,
    plans,
    handling: robotHandling(plans),
    gripper,
    warnings,
    telemetry(robotId) {
      if (!cache.has(robotId)) {
        const plan = plans.get(robotId);
        cache.set(
          robotId,
          plan
            ? sampleTelemetry(plan, {
                start: log.start_s,
                end: log.end_s,
                gripper: gripper.get(robotId) ?? 'mechanical',
              })
            : null,
        );
      }
      return cache.get(robotId)!;
    },
  };
}
