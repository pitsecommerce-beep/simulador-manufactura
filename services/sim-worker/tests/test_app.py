"""Tests del servicio HTTP, la persistencia y el cliente de Supabase (sin red)."""

from __future__ import annotations

import gzip
import json
from concurrent.futures import Future
from typing import Any

import httpx
from fastapi.testclient import TestClient

from sim_worker.app import Settings, create_app
from sim_worker.jobs import execute
from sim_worker.model import SimRequest
from sim_worker.testing import chain, fixed, request, sink, source, station
from sim_worker.writer import SupabaseWriter

SETTINGS = Settings(
    token="secreto", supabase_url="https://x.supabase.co", secret_key="k", max_replications=5
)


class FakeWriter:
    def __init__(self) -> None:
        self.updates: list[dict[str, Any]] = []
        self.metrics: list[dict[str, Any]] = []
        self.files: dict[str, bytes] = {}

    def update_run(self, run_id: str, fields: dict[str, Any]) -> None:
        self.updates.append({"run_id": run_id, **fields})

    def insert_metrics(self, rows: list[dict[str, Any]]) -> None:
        self.metrics.extend(rows)

    def upload_events(self, path: str, data: bytes) -> None:
        self.files[path] = data


def ok_request(**kw: Any) -> SimRequest:
    return request(
        [source("src", fixed(10)), station("st", fixed(5)), sink("out")],
        chain("src", "st", "out"),
        replications=2,
        **kw,
    )


def inline_app() -> tuple[TestClient, FakeWriter]:
    writer = FakeWriter()

    def submit(payload: dict[str, Any], _s: Settings) -> Future[None]:
        execute(SimRequest.model_validate(payload), writer)
        f: Future[None] = Future()
        f.set_result(None)
        return f

    return TestClient(create_app(SETTINGS, submit)), writer


def body(req: SimRequest) -> dict[str, Any]:
    return req.model_dump(by_alias=True)


def test_exige_token() -> None:
    client, _ = inline_app()
    assert client.post("/runs", json=body(ok_request())).status_code == 401
    bad = client.post("/runs", json=body(ok_request()), headers={"Authorization": "Bearer otro"})
    assert bad.status_code == 401
    assert client.get("/health").json()["status"] == "ok"


def test_rechaza_modelos_invalidos_y_demasiadas_replicas() -> None:
    client, _ = inline_app()
    auth = {"Authorization": "Bearer secreto"}
    payload = body(ok_request())
    payload["model"]["routes"].append({"from": "st", "to": "nadie"})
    assert client.post("/runs", json=payload, headers=auth).status_code == 422
    many = body(ok_request())
    many["config"]["replications"] = 6
    assert client.post("/runs", json=many, headers=auth).status_code == 422


def test_corrida_completa_guarda_estado_metricas_y_eventos() -> None:
    client, writer = inline_app()
    req = ok_request()
    payload = body(req) | {"assumptions": ["st: ciclo 5 s (supuesto del usuario)"]}
    res = client.post("/runs", json=payload, headers={"Authorization": "Bearer secreto"})
    assert res.status_code == 202
    statuses = [u["status"] for u in writer.updates if "status" in u]
    assert statuses == ["running", "succeeded"]
    final = writer.updates[-1]
    assert final["events_path"] == "runs/r/events.json.gz"
    assert final["summary"]["assumptions"] == ["st: ciclo 5 s (supuesto del usuario)"]
    assert final["summary"]["bottleneck"]["node"] == "st"
    events = json.loads(gzip.decompress(writer.files["runs/r/events.json.gz"]))
    assert events["events"]
    assert all(
        m["run_id"] == "r" and m["project_id"] == "p" and m["is_estimate"] for m in writer.metrics
    )
    assert {m["metric"] for m in writer.metrics} >= {
        "throughput_per_hour",
        "oee",
        "busy",
        "wip_avg",
    }


def test_un_error_deja_la_corrida_en_failed() -> None:
    writer = FakeWriter()
    req = request(
        [source("src", fixed(10), item="otro"), station("st", fixed(5)), sink("out")],
        [{"from": "src", "to": "st", "item": "P"}, {"from": "st", "to": "out"}],
        replications=1,
    )
    execute(req, writer)
    assert writer.updates[-1]["status"] == "failed"
    assert "no hay ruta" in writer.updates[-1]["error"]


def test_cliente_supabase_usa_apikey_y_rutas_correctas() -> None:
    seen: list[httpx.Request] = []

    def handler(r: httpx.Request) -> httpx.Response:
        seen.append(r)
        return httpx.Response(201 if r.method == "POST" else 204)

    w = SupabaseWriter(
        "https://x.supabase.co/",
        "sb_secret_abc",
        httpx.Client(transport=httpx.MockTransport(handler)),
    )
    w.update_run("r1", {"status": "running"})
    w.insert_metrics([{"metric": "m"}] * 1200)
    w.upload_events("runs/r1/events.json.gz", b"x")
    assert seen[0].method == "PATCH" and seen[0].url.params["id"] == "eq.r1"
    assert all(r.headers["apikey"] == "sb_secret_abc" for r in seen)
    assert "authorization" not in seen[0].headers  # clave nueva: solo apikey
    assert len([r for r in seen if r.url.path == "/rest/v1/simulation_metrics"]) == 3
    assert seen[-1].url.path == "/storage/v1/object/sim-artifacts/runs/r1/events.json.gz"
    legacy = SupabaseWriter(
        "https://x.supabase.co", "eyJlegacy", httpx.Client(transport=httpx.MockTransport(handler))
    )
    legacy.update_run("r1", {})
    assert seen[-1].headers["authorization"] == "Bearer eyJlegacy"


def test_cliente_supabase_reporta_errores() -> None:
    w = SupabaseWriter(
        "https://x.supabase.co",
        "k",
        httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(401, text="no"))),
    )
    try:
        w.update_run("r", {})
    except RuntimeError as err:
        assert "401" in str(err)
    else:
        raise AssertionError("debía fallar")
