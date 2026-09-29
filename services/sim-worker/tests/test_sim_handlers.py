import pytest

from jobqueue import Job, UnsupportedJobError
from sim_worker.handlers import HANDLERS


def job(kind: str, payload: dict[str, object] | None = None) -> Job:
    return Job(id=1, kind=kind, payload=payload or {}, attempts=1, max_attempts=3)


def test_ping_informa_version_de_simpy() -> None:
    result = HANDLERS["ping"](job("ping", {"echo": "hola"}))
    assert result is not None
    assert result["worker"] == "sim-worker"
    assert result["echo"] == "hola"
    assert result["simpy"]


def test_entrenamiento_no_soportado_en_etapa_1() -> None:
    with pytest.raises(UnsupportedJobError, match="GPU"):
        HANDLERS["train_policy"](job("train_policy"))
