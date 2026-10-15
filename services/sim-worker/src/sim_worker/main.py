"""Punto de entrada del sim-worker: servicio HTTP interno (uvicorn).

Variables: SIM_WORKER_TOKEN, SUPABASE_URL, SUPABASE_SECRET_KEY y, opcionales,
SIM_MAX_REPLICATIONS (50), SIM_MAX_CONCURRENT_RUNS (1), PORT (8080).
No usa DATABASE_URL.
"""

from __future__ import annotations

import logging
import multiprocessing
import os
import socket
import sys
from concurrent.futures import ProcessPoolExecutor

import uvicorn

from sim_worker.app import Settings, create_app, process_submitter


def listen_host() -> str:
    """'::' (IPv6, lo que usa la red privada de Railway) o 0.0.0.0 si no hay IPv6."""
    if os.environ.get("SIM_WORKER_HOST"):
        return os.environ["SIM_WORKER_HOST"]
    try:
        with socket.socket(socket.AF_INET6, socket.SOCK_STREAM):
            return "::"
    except OSError:
        return "0.0.0.0"  # noqa: S104 - servicio interno, sin dominio público


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    missing = [
        k
        for k in ("SIM_WORKER_TOKEN", "SUPABASE_URL", "SUPABASE_SECRET_KEY")
        if not os.environ.get(k)
    ]
    if missing:
        sys.exit(f"Faltan variables: {', '.join(missing)}")
    settings = Settings(
        token=os.environ["SIM_WORKER_TOKEN"],
        supabase_url=os.environ["SUPABASE_URL"],
        secret_key=os.environ["SUPABASE_SECRET_KEY"],
        max_replications=int(os.environ.get("SIM_MAX_REPLICATIONS", "50")),
    )
    workers = int(os.environ.get("SIM_MAX_CONCURRENT_RUNS", "1"))
    executor = ProcessPoolExecutor(workers, mp_context=multiprocessing.get_context("spawn"))
    app = create_app(settings, process_submitter(executor))
    host = listen_host()
    uvicorn.run(app, host=host, port=int(os.environ.get("PORT", "8080")), log_level="info")


if __name__ == "__main__":
    main()
