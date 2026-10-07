"""Ejecuta una corrida completa: réplicas, agregación, cuello de botella y registro de eventos."""

from __future__ import annotations

import statistics
from collections.abc import Callable
from importlib.metadata import version
from typing import Any

from sim_worker.engine import Recorder, Replication
from sim_worker.model import SimRequest, Station
from sim_worker.stats import aggregate

ENGINE_VERSION = f"sim-worker 0.2 (SimPy {version('simpy')})"


def run_request(
    req: SimRequest,
    progress: Callable[[float], None] = lambda _p: None,
) -> dict[str, Any]:
    model, cfg = req.model, req.config
    names = {n.object_id: n.name for n in model.nodes}
    reps: list[dict[str, Any]] = []
    for i in range(cfg.replications):
        reps.append(Replication(model, cfg, i).run())
        progress((i + 1) / (cfg.replications + 1))

    rows = aggregate(reps, names)

    # Cuello de botella: estación con mayor fracción ocupada + en falla (promedio).
    stations = [n for n in model.nodes if isinstance(n, Station)]
    ranked = sorted(
        (
            (
                statistics.fmean(
                    r["stations"][s.object_id]["busy"] + r["stations"][s.object_id]["failed"]
                    for r in reps
                ),
                s,
            )
            for s in stations
        ),
        key=lambda x: -x[0],
    )
    bottleneck = None
    if ranked:
        top, s = ranked[0]
        second = (
            {"node": ranked[1][1].object_id, "name": ranked[1][1].name, "busy_failed": ranked[1][0]}
            if len(ranked) > 1
            else None
        )
        bottleneck = {"node": s.object_id, "name": s.name, "busy_failed": top, "second": second}
        # OEE de la línea = OEE del cuello de botella.
        src = next(r for r in rows if r["metric"] == "oee" and r["scope"] == s.object_id)
        rows.append({**src, "scope": "line", "label": "Línea (cuello de botella)"})

    # Réplica representativa: producción por hora más cercana al promedio; se repite
    # (misma semilla, mismo resultado) registrando los eventos de la ventana.
    th = [r["line"]["throughput_per_hour"] for r in reps]
    mean_th = statistics.fmean(th)
    rep_idx = min(range(len(th)), key=lambda i: abs(th[i] - mean_th))
    start = cfg.warmup_h * 3600
    recorder = Recorder(
        start, min(start + req.playback_window_s, cfg.horizon_h * 3600), req.max_events
    )
    Replication(model, cfg, rep_idx, recorder).run()
    progress(1.0)

    # Producción por réplica, para ver la dispersión.
    for i, r in enumerate(reps):
        for metric in ("throughput_per_hour", "total_output"):
            v = r["line"][metric]
            rows.append(
                {
                    "metric": metric,
                    "scope": "line",
                    "label": "Línea",
                    "unit": "u/h" if metric == "throughput_per_hour" else "u",
                    "replication": i,
                    "value": v,
                    "min": None,
                    "mean": None,
                    "max": None,
                    "p5": None,
                    "p95": None,
                    "ci_low": None,
                    "ci_high": None,
                }
            )

    notes = [
        "Bloqueo tras servicio; entre estaciones sin buffer la capacidad es 0.",
        "Si la línea no puede recibir, la fuente espera: no se acumulan llegadas fuera.",
        "Fallas sobre tiempo de operación (tiempo hasta falla exponencial con media MTBF).",
        "OEE de la línea = OEE del cuello de botella; ciclo ideal = media del tiempo de ciclo.",
    ]
    if any(isinstance(n, Station) and n.operation == "assemble" for n in model.nodes):
        notes.append("Las estaciones de ensamblaje admiten en espera un juego de componentes.")
    if recorder.truncated:
        notes.append(f"El registro de eventos se recortó a {req.max_events} eventos.")

    return {
        "metrics": rows,
        "summary": {
            "bottleneck": bottleneck,
            "notes": notes,
            "representative_replication": rep_idx,
            "takt_time_s": 3600 / cfg.demand_per_hour if cfg.demand_per_hour else None,
        },
        "events": {
            "start_s": recorder.start,
            "end_s": recorder.end,
            "replication": rep_idx,
            "truncated": recorder.truncated,
            "events": recorder.events,
        },
        "engine_version": ENGINE_VERSION,
    }
