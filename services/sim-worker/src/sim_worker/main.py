"""Punto de entrada del sim-worker. Requiere DATABASE_URL (conexión directa o session pooler)."""

from __future__ import annotations

import logging
import os
import signal
import socket
import sys
import threading

from jobqueue import run_worker
from sim_worker.handlers import HANDLERS


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    url = os.environ.get("DATABASE_URL")
    if not url:
        sys.exit("DATABASE_URL no está definida")
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    worker = f"sim-worker@{os.environ.get('RAILWAY_REPLICA_ID', socket.gethostname())}"
    run_worker(url, worker, HANDLERS, stop, float(os.environ.get("POLL_SECONDS", "5")))


if __name__ == "__main__":
    main()
