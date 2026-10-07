"""Agregación de réplicas: mínimo, promedio, máximo, percentiles e intervalo de confianza."""

from __future__ import annotations

import math
import statistics
from typing import Any

# t de Student (dos colas, 95 %) para n-1 grados de libertad; con más de 30 se usa 1.96.
_T95 = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
]  # fmt: skip


def percentile(sorted_vals: list[float], q: float) -> float:
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


def summarize(values: list[float | None]) -> dict[str, float | None]:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return dict.fromkeys(("min", "mean", "max", "p5", "p95", "ci_low", "ci_high"))
    mean = statistics.fmean(vals)
    n = len(vals)
    half: float | None = None
    if n > 1:
        t = _T95[n - 2] if n - 1 <= len(_T95) else 1.96
        half = t * statistics.stdev(vals) / math.sqrt(n)
    return {
        "min": vals[0],
        "mean": mean,
        "max": vals[-1],
        "p5": percentile(vals, 0.05),
        "p95": percentile(vals, 0.95),
        "ci_low": mean - half if half is not None else None,
        "ci_high": mean + half if half is not None else None,
    }


PERCENT = {"busy", "blocked", "failed", "starved", "availability", "performance", "quality", "oee"}
UNITS = {
    "throughput_per_hour": "u/h",
    "total_output": "u",
    "pallets_completed": "pallets",
    "line_cycle_time_s": "s/u",
    "flow_time_s": "s",
    "wip_avg": "u",
    "scrap_units": "u",
    "buffer_avg": "u",
}


def aggregate(reps: list[dict[str, Any]], names: dict[str, str]) -> list[dict[str, Any]]:
    """Filas de métricas agregadas (replication = None) a partir de los resultados por réplica."""
    rows: list[dict[str, Any]] = []

    def emit(metric: str, scope: str, label: str | None, values: list[float | None]) -> None:
        scale = 100.0 if metric in PERCENT else 1.0
        s = summarize([v * scale if v is not None else None for v in values])
        rows.append(
            {
                "metric": metric,
                "scope": scope,
                "label": label,
                "unit": "%" if metric in PERCENT else UNITS.get(metric),
                "replication": None,
                "value": s["mean"],
                **s,
            }
        )

    for metric in reps[0]["line"]:
        emit(metric, "line", "Línea", [r["line"][metric] for r in reps])
    for sid in reps[0]["stations"]:
        for metric in reps[0]["stations"][sid]:
            emit(metric, sid, names.get(sid), [r["stations"][sid][metric] for r in reps])
    for bid in reps[0]["buffers"]:
        emit("buffer_avg", bid, names.get(bid), [r["buffers"][bid]["buffer_avg"] for r in reps])
    return rows
