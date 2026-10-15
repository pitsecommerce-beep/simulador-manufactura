"""Ejecución de una corrida y persistencia de sus resultados."""

from __future__ import annotations

import gzip
import json
import logging
from datetime import UTC, datetime
from typing import Any

from sim_worker.model import SimRequest
from sim_worker.runner import ENGINE_VERSION, run_request
from sim_worker.writer import ResultWriter, SupabaseWriter

log = logging.getLogger("sim_worker")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def execute(req: SimRequest, writer: ResultWriter) -> None:
    """Simula y guarda. Cualquier error deja la corrida en `failed` con su mensaje."""
    run_id = req.run_id
    writer.update_run(
        run_id,
        {
            "status": "running",
            "started_at": _now(),
            "engine_version": ENGINE_VERSION,
            "progress": 0,
        },
    )
    last = [0.0]

    def progress(p: float) -> None:
        # Se informa en saltos de 10 % para no saturar la base.
        if p - last[0] >= 0.1 and p < 1:
            last[0] = p
            writer.update_run(run_id, {"progress": round(p, 2)})

    try:
        res = run_request(req, progress)
        path = f"runs/{run_id}/events.json.gz"
        writer.upload_events(path, gzip.compress(json.dumps(res["events"]).encode()))
        rows = [
            {**r, "run_id": run_id, "project_id": req.project_id, "is_estimate": True}
            for r in res["metrics"]
        ]
        writer.insert_metrics(rows)
        writer.update_run(
            run_id,
            {
                "status": "succeeded",
                "finished_at": _now(),
                "progress": 1,
                "events_path": path,
                "summary": {**res["summary"], "assumptions": req.assumptions},
            },
        )
        log.info("corrida %s terminada", run_id)
    except Exception as err:  # noqa: BLE001 - toda falla se reporta en la corrida
        log.exception("corrida %s falló", run_id)
        writer.update_run(
            run_id, {"status": "failed", "finished_at": _now(), "error": str(err)[:2000]}
        )


def execute_in_process(payload: dict[str, Any], supabase_url: str, secret_key: str) -> None:
    """Punto de entrada en el proceso hijo (argumentos serializables)."""
    logging.basicConfig(level=logging.INFO)
    execute(SimRequest.model_validate(payload), SupabaseWriter(supabase_url, secret_key))
