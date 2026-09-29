"""Manejadores de trabajos de conversión CAD. La conversión real llega en la fase 2."""

from __future__ import annotations

import platform
from typing import Any

from jobqueue import Job


def ping(job: Job) -> dict[str, Any]:
    return {
        "worker": "cad-worker",
        "python": platform.python_version(),
        "echo": job.payload.get("echo"),
    }


HANDLERS = {"ping": ping}
