"""Constructores de modelos para los tests del motor."""

from __future__ import annotations

from typing import Any

from sim_worker.model import RunConfig, SimModel, SimRequest


def fixed(v: float) -> dict[str, Any]:
    return {"dist": {"type": "fixed", "value": v}, "origin": "user"}


def expo(mean: float) -> dict[str, Any]:
    return {"dist": {"type": "exponential", "mean": mean}, "origin": "user"}


def source(id_: str, every: dict[str, Any], item: str = "P") -> dict[str, Any]:
    return {"role": "source", "object_id": id_, "name": id_, "item": item, "interarrival": every}


def station(id_: str, cycle: dict[str, Any], **extra: Any) -> dict[str, Any]:
    return {"role": "station", "object_id": id_, "name": id_, "cycle": cycle, **extra}


def buffer(id_: str, capacity: int, transfer: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "role": "buffer",
        "object_id": id_,
        "name": id_,
        "capacity": capacity,
        "transfer": transfer,
    }


def sink(id_: str, units: int = 10, change: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "role": "sink",
        "object_id": id_,
        "name": id_,
        "units_per_pallet": units,
        "pallet_change": change,
    }


def chain(*ids: str) -> list[dict[str, Any]]:
    return [{"from": a, "to": b} for a, b in zip(ids, ids[1:], strict=False)]


def request(
    nodes: list[dict[str, Any]],
    routes: list[dict[str, Any]],
    *,
    horizon_h: float = 10,
    warmup_h: float = 1,
    replications: int = 3,
    seed: int = 7,
    bom: list[dict[str, Any]] | None = None,
    demand: float | None = None,
    window: float = 600,
) -> SimRequest:
    return SimRequest(
        run_id="r",
        project_id="p",
        model=SimModel.model_validate(
            {"product": {"name": "P", "bom": bom or []}, "nodes": nodes, "routes": routes}
        ),
        config=RunConfig(
            name="t",
            horizon_h=horizon_h,
            warmup_h=warmup_h,
            replications=replications,
            seed=seed,
            demand_per_hour=demand,
        ),
        playback_window_s=window,
    )
