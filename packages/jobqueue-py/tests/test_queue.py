from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from psycopg.types.json import Jsonb

from jobqueue import Job, JobQueue, NeedsMappingError, UnsupportedJobError
from jobqueue.testing import temporary_database


@pytest.fixture(scope="module")
def db_url() -> Iterator[str]:
    with temporary_database() as url:
        yield url


@pytest.fixture
def queue(db_url: str) -> Iterator[JobQueue]:
    with psycopg.connect(db_url) as conn:
        conn.execute("delete from public.jobs")
        conn.commit()
        yield JobQueue(conn, "test-worker")


def enqueue(q: JobQueue, kind: str = "ping", payload: dict[str, Any] | None = None) -> int:
    row = q.conn.execute(
        "insert into public.jobs (kind, payload) values (%s, %s) returning id",
        (kind, Jsonb(payload or {})),
    ).fetchone()
    q.conn.commit()
    assert row
    return int(row[0])


def status_of(q: JobQueue, job_id: int) -> tuple[str, Any, str | None]:
    row = q.conn.execute(
        "select status, result, last_error from public.jobs where id = %s", (job_id,)
    ).fetchone()
    q.conn.commit()
    assert row
    return row[0], row[1], row[2]


def test_procesa_un_trabajo_con_exito(queue: JobQueue) -> None:
    job_id = enqueue(queue, payload={"x": 1})
    seen: list[Job] = []

    def handler(job: Job) -> dict[str, Any]:
        seen.append(job)
        return {"echo": job.payload["x"]}

    assert queue.process_one(["ping"], {"ping": handler})
    assert seen[0].payload == {"x": 1}
    assert status_of(queue, job_id)[:2] == ("succeeded", {"echo": 1})
    assert not queue.process_one(["ping"], {"ping": handler})


def test_marca_trabajos_no_soportados_y_sin_mapeo(queue: JobQueue) -> None:
    a = enqueue(queue)

    def unsupported(_job: Job) -> None:
        raise UnsupportedJobError("sin GPU")

    queue.process_one(["ping"], {"ping": unsupported})
    assert status_of(queue, a)[0] == "unsupported"

    b = enqueue(queue)

    def needs_mapping(_job: Job) -> None:
        raise NeedsMappingError("falta links.json")

    queue.process_one(["ping"], {"ping": needs_mapping})
    assert status_of(queue, b)[0] == "needs_mapping"


def test_un_error_reprograma_el_trabajo(queue: JobQueue) -> None:
    job_id = enqueue(queue)

    def boom(_job: Job) -> None:
        raise RuntimeError("fallo temporal")

    queue.process_one(["ping"], {"ping": boom})
    status, _, error = status_of(queue, job_id)
    assert status == "queued"
    assert error and "fallo temporal" in error
