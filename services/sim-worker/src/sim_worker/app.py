"""Servicio HTTP interno del motor (red privada de Railway, sin dominio público)."""

from __future__ import annotations

import hmac
import threading
from collections.abc import Callable
from concurrent.futures import Executor, Future
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import FastAPI, Header, HTTPException, status

from sim_worker.model import SimRequest
from sim_worker.runner import ENGINE_VERSION


@dataclass(frozen=True)
class Settings:
    token: str
    supabase_url: str
    secret_key: str
    max_replications: int = 50
    max_queue: int = 20


Submit = Callable[[dict[str, Any], Settings], Future[None]]


def create_app(settings: Settings, submit: Submit) -> FastAPI:
    app = FastAPI(title="sim-worker", docs_url=None, redoc_url=None, openapi_url=None)
    pending: set[Future[None]] = set()
    lock = threading.Lock()

    def check_token(authorization: str | None) -> None:
        expected = f"Bearer {settings.token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token inválido")

    @app.get("/health")
    def health() -> dict[str, Any]:
        with lock:
            queued = len(pending)
        return {"status": "ok", "engine": ENGINE_VERSION, "queued": queued}

    @app.post("/runs", status_code=status.HTTP_202_ACCEPTED)
    def create_run(
        req: SimRequest, authorization: Annotated[str | None, Header()] = None
    ) -> dict[str, Any]:
        check_token(authorization)
        if req.config.replications > settings.max_replications:
            raise HTTPException(
                422,
                f"máximo {settings.max_replications} réplicas",
            )
        with lock:
            if len(pending) >= settings.max_queue:
                raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "motor ocupado")
            fut = submit(req.model_dump(by_alias=True), settings)
            pending.add(fut)

        def done(f: Future[None]) -> None:
            with lock:
                pending.discard(f)

        fut.add_done_callback(done)
        return {"accepted": True, "run_id": req.run_id}

    return app


def process_submitter(executor: Executor) -> Submit:
    from sim_worker.jobs import execute_in_process

    def submit(payload: dict[str, Any], settings: Settings) -> Future[None]:
        return executor.submit(
            execute_in_process, payload, settings.supabase_url, settings.secret_key
        )

    return submit
