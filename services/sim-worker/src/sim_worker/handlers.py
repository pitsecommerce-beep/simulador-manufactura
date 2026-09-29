"""Manejadores de trabajos del motor de simulación."""

from __future__ import annotations

import platform
from importlib.metadata import version
from typing import Any

from jobqueue import Job, UnsupportedJobError


def ping(job: Job) -> dict[str, Any]:
    """Trabajo de diagnóstico: confirma que el worker está vivo y conectado a la cola."""
    return {
        "worker": "sim-worker",
        "python": platform.python_version(),
        "simpy": version("simpy"),
        "echo": job.payload.get("echo"),
    }


def train_policy(_job: Job) -> None:
    # Etapa 1: Railway no ofrece GPU. La cola acepta el trabajo para que la interfaz
    # quede lista; un worker externo con GPU podrá consumir este tipo en el futuro.
    raise UnsupportedJobError(
        "El entrenamiento de políticas requiere GPU y no está disponible en esta etapa."
    )


HANDLERS = {"ping": ping, "train_policy": train_policy}
