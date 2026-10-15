"""Motor de línea con SimPy: una réplica de eventos discretos sin gráficos.

Semántica (ver PLAN.md, sección 22):
- Bloqueo tras servicio: una estación que termina conserva la unidad (y su lugar) hasta que
  el destino la acepta. Entre estaciones sin buffer la capacidad es 0.
- Una fuente que no puede entregar espera: las llegadas no se acumulan fuera del sistema.
- Fallas sobre tiempo de operación: el tiempo hasta la falla (exponencial, media MTBF) solo
  avanza mientras la estación procesa.
- Ensamblaje: la estación admite en espera un juego de componentes de la BOM.
- Las estadísticas se reinician al terminar el calentamiento.
"""

from __future__ import annotations

import random
from collections.abc import Generator
from dataclasses import dataclass, field
from typing import Any

import simpy
from simpy.resources.resource import Request

from sim_worker import dists
from sim_worker.model import Buffer, RunConfig, SimModel, Sink, Source, Station

Proc = Generator[simpy.Event, Any, Any]
EPS = 1e-9


class TimeWeighted:
    """Integral en el tiempo de un valor escalonado (para fracciones y promedios)."""

    def __init__(self, env: simpy.Environment, value: float = 0.0) -> None:
        self.env = env
        self.value = value
        self.last = env.now
        self.area = 0.0

    def set(self, value: float) -> None:
        self.area += self.value * (self.env.now - self.last)
        self.last = self.env.now
        self.value = value

    def add(self, delta: float) -> None:
        self.set(self.value + delta)

    def reset(self) -> None:
        self.last = self.env.now
        self.area = 0.0

    def total(self) -> float:
        return self.area + self.value * (self.env.now - self.last)


@dataclass
class Unit:
    id: int
    item: str
    t_enter: float


@dataclass
class StationRt:
    spec: Station
    servers: simpy.Resource | None
    staging: dict[str, simpy.Store]
    busy: int = 0
    blocked: int = 0
    failed: bool = False
    ttf: float | None = None
    repaired: simpy.Event | None = None
    processed: int = 0
    good: int = 0
    scrapped: int = 0
    tw: dict[str, TimeWeighted] = field(default_factory=dict)
    state: str = "idle"


@dataclass
class BufferRt:
    spec: Buffer
    slots: simpy.Resource
    occupancy: TimeWeighted


@dataclass
class SinkRt:
    spec: Sink
    gate: simpy.PriorityResource
    fill: int = 0


class Recorder:
    """Registro de eventos de una ventana de tiempo, con tope de tamaño."""

    def __init__(self, start: float, end: float, max_events: int) -> None:
        self.start = start
        self.end = end
        self.max = max_events
        self.events: list[list[Any]] = []
        self.truncated = False

    def add(self, t: float, *rest: Any) -> None:
        if t < self.start or t > self.end:
            return
        if len(self.events) >= self.max:
            self.truncated = True
            return
        self.events.append([round(t, 3), *rest])


class Replication:
    def __init__(
        self,
        model: SimModel,
        config: RunConfig,
        index: int,
        recorder: Recorder | None = None,
    ) -> None:
        self.model = model
        self.config = config
        self.index = index
        self.recorder = recorder
        self.env = simpy.Environment()
        self.warmup_s = config.warmup_h * 3600
        self.horizon_s = config.horizon_h * 3600
        self._rngs: dict[str, random.Random] = {}
        self._next_unit = 0

        self.stations: dict[str, StationRt] = {}
        self.buffers: dict[str, BufferRt] = {}
        self.sinks: dict[str, SinkRt] = {}
        self.sources: dict[str, Source] = {}
        self.out: dict[str, list[Any]] = {}
        for r in model.routes:
            self.out.setdefault(r.from_, []).append(r)

        env = self.env
        for n in model.nodes:
            if isinstance(n, Station):
                staging: dict[str, simpy.Store] = {}
                servers = None
                if n.operation == "assemble":
                    staging = {b.item: simpy.Store(env, capacity=b.qty) for b in model.product.bom}
                else:
                    servers = simpy.Resource(env, capacity=n.capacity)
                st = StationRt(spec=n, servers=servers, staging=staging)
                st.tw = {k: TimeWeighted(env) for k in ("busy", "blocked", "failed")}
                if n.failures:
                    st.ttf = self.rng(f"ttf:{n.object_id}").expovariate(1 / n.failures.mtbf_s)
                self.stations[n.object_id] = st
            elif isinstance(n, Buffer):
                self.buffers[n.object_id] = BufferRt(
                    spec=n,
                    slots=simpy.Resource(env, capacity=n.capacity),
                    occupancy=TimeWeighted(env),
                )
            elif isinstance(n, Sink):
                self.sinks[n.object_id] = SinkRt(
                    spec=n, gate=simpy.PriorityResource(env, capacity=1)
                )
            else:
                self.sources[n.object_id] = n

        # Contadores (se reinician al terminar el calentamiento).
        self.wip = TimeWeighted(env)
        self.output = 0
        self.pallets = 0
        self.flow_sum = 0.0
        self.flow_n = 0

    # -- utilidades ---------------------------------------------------------------------
    def rng(self, stream: str) -> random.Random:
        r = self._rngs.get(stream)
        if r is None:
            # random.Random con una cadena es determinista (no depende de PYTHONHASHSEED).
            r = random.Random(f"{self.config.seed}:{self.index}:{stream}")  # noqa: S311
            self._rngs[stream] = r
        return r

    def record(self, *event: Any) -> None:
        if self.recorder:
            self.recorder.add(self.env.now, *event)

    def new_unit(self, item: str) -> Unit:
        self._next_unit += 1
        self.wip.add(1)
        return Unit(self._next_unit, item, self.env.now)

    def gone(self, unit: Unit) -> None:
        self.wip.add(-1)
        self.record("gone", unit.id)

    def refresh(self, st: StationRt) -> None:
        """Actualiza las integrales de estado de la estación (la falla tiene prioridad)."""
        failed = st.failed
        st.tw["busy"].set(0 if failed else st.busy)
        st.tw["blocked"].set(0 if failed else st.blocked)
        st.tw["failed"].set(st.spec.capacity if failed else 0)
        state = "failed" if failed else "busy" if st.busy else "blocked" if st.blocked else "idle"
        if state != st.state:
            st.state = state
            self.record("st", st.spec.object_id, state)

    def choose(self, frm: str, unit: Unit) -> str:
        routes = [r for r in self.out.get(frm, []) if r.item is None or r.item == unit.item]
        if not routes:
            raise ValueError(f"{frm}: no hay ruta para el artículo {unit.item!r}")
        if len(routes) == 1:
            return str(routes[0].to)
        if all(r.share is not None for r in routes):
            x = self.rng(f"route:{frm}").random()
            acc = 0.0
            for r in routes:
                acc += r.share
                if x < acc:
                    return str(r.to)
        return str(routes[-1].to)

    # -- flujo ----------------------------------------------------------------------------
    def push(self, target: str, unit: Unit) -> Proc:
        """Entrega la unidad al destino; bloquea hasta que el destino la acepta."""
        if target in self.stations:
            st = self.stations[target]
            if st.servers is not None:
                req = st.servers.request()
                yield req
                self.record("at", unit.id, target)
                self.env.process(self.station_unit(st, unit, req))
            else:
                store = st.staging.get(unit.item)
                if store is None:
                    raise ValueError(f"{st.spec.name} no usa el artículo {unit.item!r}")
                yield store.put(unit)
                self.record("at", unit.id, target)
        elif target in self.buffers:
            buf = self.buffers[target]
            req = buf.slots.request()
            yield req
            buf.occupancy.add(1)
            self.record("at", unit.id, target)
            self.env.process(self.buffer_unit(buf, unit, req))
        else:
            sink = self.sinks[target]
            req = sink.gate.request(priority=1)
            yield req
            sink.gate.release(req)
            self.record("at", unit.id, target)
            self.exit(sink, unit)

    def work(self, st: StationRt, duration: float) -> Proc:
        """Procesa `duration` segundos de operación, con fallas sobre tiempo de operación."""
        remaining = duration
        while remaining > EPS:
            while st.failed and st.repaired is not None:
                yield st.repaired
            if st.ttf is None:
                yield self.env.timeout(remaining)
                return
            run = min(remaining, st.ttf)
            yield self.env.timeout(run)
            remaining -= run
            st.ttf -= run
            if st.ttf <= EPS and not st.failed:
                self.fail(st)

    def fail(self, st: StationRt) -> None:
        assert st.spec.failures is not None
        st.failed = True
        st.repaired = self.env.event()
        self.refresh(st)
        self.env.process(self.repair(st))

    def repair(self, st: StationRt) -> Proc:
        f = st.spec.failures
        assert f is not None and st.repaired is not None
        yield self.env.timeout(dists.sample(f.mttr, self.rng(f"mttr:{st.spec.object_id}")))
        st.failed = False
        st.ttf = self.rng(f"ttf:{st.spec.object_id}").expovariate(1 / f.mtbf_s)
        done = st.repaired
        st.repaired = None
        self.refresh(st)
        done.succeed()

    def finish_unit(self, st: StationRt, unit: Unit) -> Proc:
        """Tras el ciclo: scrap o entrega aguas abajo (bloqueada si no hay lugar)."""
        st.processed += 1
        sc = st.spec.scrap
        if sc and self.rng(f"scrap:{st.spec.object_id}").random() < sc.rate:
            st.scrapped += 1
            self.gone(unit)
            return
        st.blocked += 1
        self.refresh(st)
        yield from self.push(self.choose(st.spec.object_id, unit), unit)
        st.blocked -= 1
        st.good += 1
        self.refresh(st)

    def station_unit(self, st: StationRt, unit: Unit, req: Request) -> Proc:
        assert st.servers is not None
        st.busy += 1
        self.refresh(st)
        rng = self.rng(f"cycle:{st.spec.object_id}")
        yield from self.work(st, dists.sample(st.spec.cycle.dist, rng))
        st.busy -= 1
        self.refresh(st)
        yield from self.finish_unit(st, unit)
        st.servers.release(req)

    def assembler(self, st: StationRt) -> Proc:
        bom = self.model.product.bom
        rng = self.rng(f"cycle:{st.spec.object_id}")
        while True:
            parts: list[Unit] = []
            for b in bom:
                for _ in range(b.qty):
                    part = yield st.staging[b.item].get()
                    parts.append(part)
            st.busy += 1
            self.refresh(st)
            yield from self.work(st, dists.sample(st.spec.cycle.dist, rng))
            st.busy -= 1
            self.refresh(st)
            for p in parts:
                self.gone(p)
            product = self.new_unit(self.model.product.name)
            product.t_enter = min(p.t_enter for p in parts)
            self.record("at", product.id, st.spec.object_id)
            yield from self.finish_unit(st, product)

    def buffer_unit(self, buf: BufferRt, unit: Unit, req: Request) -> Proc:
        t = buf.spec.transfer
        if t is not None:
            yield self.env.timeout(dists.sample(t.dist, self.rng(f"transfer:{buf.spec.object_id}")))
        yield from self.push(self.choose(buf.spec.object_id, unit), unit)
        buf.slots.release(req)
        buf.occupancy.add(-1)

    def source(self, src: Source) -> Proc:
        rng = self.rng(f"arrival:{src.object_id}")
        while True:
            yield self.env.timeout(dists.sample(src.interarrival.dist, rng))
            for _ in range(src.batch):
                unit = self.new_unit(src.item)
                self.record("at", unit.id, src.object_id)
                yield from self.push(self.choose(src.object_id, unit), unit)

    def exit(self, sink: SinkRt, unit: Unit) -> None:
        self.gone(unit)
        if self.env.now >= self.warmup_s:
            self.output += 1
            self.flow_sum += self.env.now - unit.t_enter
            self.flow_n += 1
        sink.fill += 1
        if sink.fill >= sink.spec.units_per_pallet:
            sink.fill = 0
            if self.env.now >= self.warmup_s:
                self.pallets += 1
            if sink.spec.pallet_change is not None:
                self.env.process(self.pallet_change(sink))

    def pallet_change(self, sink: SinkRt) -> Proc:
        assert sink.spec.pallet_change is not None
        req = sink.gate.request(priority=0)  # antes que las unidades en espera
        yield req
        rng = self.rng(f"pallet:{sink.spec.object_id}")
        yield self.env.timeout(dists.sample(sink.spec.pallet_change.dist, rng))
        sink.gate.release(req)

    def end_warmup(self) -> Proc:
        yield self.env.timeout(self.warmup_s)
        for st in self.stations.values():
            for tw in st.tw.values():
                tw.reset()
            st.processed = st.good = st.scrapped = 0
        for buf in self.buffers.values():
            buf.occupancy.reset()
        self.wip.reset()
        self.output = self.pallets = self.flow_n = 0
        self.flow_sum = 0.0

    # -- ejecución --------------------------------------------------------------------------
    def run(self) -> dict[str, Any]:
        for src in self.sources.values():
            self.env.process(self.source(src))
        for st in self.stations.values():
            if st.spec.operation == "assemble":
                for _ in range(st.spec.capacity):
                    self.env.process(self.assembler(st))
            self.record("st", st.spec.object_id, "idle")
        if self.warmup_s > 0:
            self.env.process(self.end_warmup())
        self.env.run(until=self.horizon_s)
        return self.results()

    def results(self) -> dict[str, Any]:
        period = self.horizon_s - self.warmup_s
        line: dict[str, float | None] = {
            "throughput_per_hour": self.output / (period / 3600),
            "total_output": float(self.output),
            "pallets_completed": float(self.pallets),
            "line_cycle_time_s": period / self.output if self.output else None,
            "flow_time_s": self.flow_sum / self.flow_n if self.flow_n else None,
            "wip_avg": self.wip.total() / period,
            "scrap_units": float(sum(s.scrapped for s in self.stations.values())),
        }
        stations: dict[str, dict[str, float | None]] = {}
        for sid, st in self.stations.items():
            c = st.spec.capacity
            busy = st.tw["busy"].total() / (c * period)
            blocked = st.tw["blocked"].total() / (c * period)
            failed = st.tw["failed"].total() / (c * period)
            availability = 1 - failed
            ideal = dists.mean(st.spec.cycle.dist)
            performance = (
                ideal * st.processed / (c * period * availability) if availability > EPS else None
            )
            quality = st.good / st.processed if st.processed else None
            stations[sid] = {
                "busy": busy,
                "blocked": blocked,
                "failed": failed,
                "starved": max(0.0, 1 - busy - blocked - failed),
                "availability": availability,
                "performance": performance,
                "quality": quality,
                "oee": ideal * st.good / (c * period),
                "scrap_units": float(st.scrapped),
            }
        buffers = {
            bid: {"buffer_avg": b.occupancy.total() / period} for bid, b in self.buffers.items()
        }
        return {"line": line, "stations": stations, "buffers": buffers}
