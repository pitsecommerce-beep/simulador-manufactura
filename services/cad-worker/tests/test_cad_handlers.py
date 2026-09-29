from cad_worker.handlers import HANDLERS
from jobqueue import Job


def test_ping() -> None:
    result = HANDLERS["ping"](Job(id=1, kind="ping", payload={}, attempts=1, max_attempts=3))
    assert result is not None
    assert result["worker"] == "cad-worker"


def test_aun_no_reclama_trabajos_de_conversion() -> None:
    # Hasta la fase 2 el worker no debe tomar trabajos convert_cad (quedarían sin procesar).
    assert set(HANDLERS) == {"ping"}
