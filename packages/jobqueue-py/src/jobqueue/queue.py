from __future__ import annotations

import logging
import threading
import traceback
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

log = logging.getLogger("jobqueue")


class UnsupportedJobError(Exception):
    """El trabajo no se puede ejecutar en este entorno (termina como 'unsupported')."""


class NeedsMappingError(Exception):
    """Falta información manual, p. ej. el mapeo de eslabones de un CAD ('needs_mapping')."""


@dataclass(frozen=True)
class Job:
    id: int
    kind: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int


Handler = Callable[[Job], dict[str, Any] | None]


class JobQueue:
    def __init__(self, conn: psycopg.Connection[Any], worker: str) -> None:
        self.conn = conn
        self.worker = worker

    def claim(self, kinds: list[str]) -> Job | None:
        with self.conn.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "select id, kind, payload, attempts, max_attempts from private.claim_job(%s, %s)",
                (kinds, self.worker),
            )
            row = cur.fetchone()
        self.conn.commit()
        if row is None:
            return None
        return Job(
            id=row["id"],
            kind=row["kind"],
            payload=row["payload"] or {},
            attempts=row["attempts"],
            max_attempts=row["max_attempts"],
        )

    def finish(
        self,
        job_id: int,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                "select private.finish_job(%s, %s, %s, %s)",
                (job_id, status, Jsonb(result) if result is not None else None, error),
            )
        self.conn.commit()

    def process_one(self, kinds: list[str], handlers: Mapping[str, Handler]) -> bool:
        """Toma y ejecuta un trabajo. Devuelve False si no había trabajos."""
        job = self.claim(kinds)
        if job is None:
            return False
        log.info("trabajo %s (%s) intento %s", job.id, job.kind, job.attempts)
        try:
            result = handlers[job.kind](job)
        except UnsupportedJobError as err:
            self.finish(job.id, "unsupported", error=str(err))
        except NeedsMappingError as err:
            self.finish(job.id, "needs_mapping", error=str(err))
        except Exception as err:  # noqa: BLE001 - cualquier fallo se registra y se reintenta
            log.exception("trabajo %s falló", job.id)
            detail = f"{err}\n{traceback.format_exc(limit=5)}"
            self.finish(job.id, "failed", error=detail[:4000])
        else:
            self.finish(job.id, "succeeded", result=result or {})
        return True


def run_worker(
    database_url: str,
    worker: str,
    handlers: Mapping[str, Handler],
    stop: threading.Event,
    poll_seconds: float = 5.0,
) -> None:
    """Bucle principal: procesa trabajos y, si no hay, espera un NOTIFY o el intervalo."""
    kinds = list(handlers)
    with (
        psycopg.connect(database_url, autocommit=False) as conn,
        psycopg.connect(database_url, autocommit=True) as listen_conn,
    ):
        for kind in kinds:
            listen_conn.execute(f'listen "jobs_{kind}"')
        queue = JobQueue(conn, worker)
        log.info("%s escuchando trabajos: %s", worker, ", ".join(kinds))
        while not stop.is_set():
            if queue.process_one(kinds, handlers):
                continue
            # Espera un NOTIFY en tramos cortos para responder rápido a SIGTERM.
            waited = 0.0
            while waited < poll_seconds and not stop.is_set():
                step = min(1.0, poll_seconds - waited)
                if any(True for _ in listen_conn.notifies(timeout=step, stop_after=1)):
                    break
                waited += step
        log.info("%s detenido", worker)
