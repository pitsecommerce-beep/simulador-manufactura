"""Tests del motor contra resultados teóricos simples."""

from __future__ import annotations

from typing import Any

import pytest

from sim_worker.runner import run_request
from sim_worker.testing import buffer, chain, expo, fixed, request, sink, source, station


def metric(res: dict[str, Any], name: str, scope: str = "line") -> dict[str, Any]:
    return next(
        r
        for r in res["metrics"]
        if r["metric"] == name and r["scope"] == scope and r["replication"] is None
    )


def test_mm1_contra_teoria() -> None:
    # Llegadas Poisson (media 10 s) y servicio exponencial (media 7 s): rho = 0.7.
    lam, mu = 1 / 10, 1 / 7
    rho = lam / mu
    req = request(
        [
            source("src", expo(10)),
            buffer("cola", 1_000_000),
            station("st", expo(7)),
            sink("out", 1000),
        ],
        chain("src", "cola", "st", "out"),
        horizon_h=125,
        warmup_h=5,
        replications=6,
    )
    res = run_request(req)
    assert metric(res, "throughput_per_hour")["mean"] == pytest.approx(lam * 3600, rel=0.03)
    assert metric(res, "busy", "st")["mean"] == pytest.approx(rho * 100, rel=0.03)
    # L = rho / (1 - rho) unidades en el sistema (cola + servicio).
    assert metric(res, "wip_avg")["mean"] == pytest.approx(rho / (1 - rho), rel=0.08)
    # W = 1 / (mu - lambda) segundos.
    assert metric(res, "flow_time_s")["mean"] == pytest.approx(1 / (mu - lam), rel=0.08)


def test_linea_en_serie_con_tiempos_fijos() -> None:
    # Fuente rápida, A = 8 s, B = 10 s, sin buffers: la línea va al ritmo de B.
    req = request(
        [source("src", fixed(5)), station("A", fixed(8)), station("B", fixed(10)), sink("out", 36)],
        chain("src", "A", "B", "out"),
        replications=2,
    )
    res = run_request(req)
    th = metric(res, "throughput_per_hour")
    assert th["mean"] == pytest.approx(360, abs=1)
    assert metric(res, "line_cycle_time_s")["mean"] == pytest.approx(10, abs=0.05)
    assert metric(res, "busy", "A")["mean"] == pytest.approx(80, abs=0.5)
    assert metric(res, "blocked", "A")["mean"] == pytest.approx(20, abs=0.5)
    assert metric(res, "busy", "B")["mean"] == pytest.approx(100, abs=0.5)
    assert res["summary"]["bottleneck"]["node"] == "B"
    assert res["summary"]["bottleneck"]["second"]["node"] == "A"
    # 360 u/h en 9 h medidas = 3240 unidades = 90 pallets de 36.
    assert metric(res, "pallets_completed")["mean"] == pytest.approx(90, abs=1)
    # Determinista: todas las réplicas iguales, intervalo de ancho cero.
    assert th["min"] == th["max"]


def test_estacion_lenta_primero_deja_en_espera_a_la_siguiente() -> None:
    req = request(
        [source("src", fixed(1)), station("A", fixed(10)), station("B", fixed(8)), sink("out")],
        chain("src", "A", "B", "out"),
        replications=1,
    )
    res = run_request(req)
    assert metric(res, "busy", "B")["mean"] == pytest.approx(80, abs=0.5)
    assert metric(res, "starved", "B")["mean"] == pytest.approx(20, abs=0.5)


def test_un_buffer_entre_estaciones_variables_aumenta_la_produccion() -> None:
    def th(cap: int | None) -> float:
        nodes = [source("src", fixed(1)), station("A", expo(9)), station("B", expo(9)), sink("out")]
        ids = ["src", "A", "B", "out"]
        if cap:
            nodes.insert(2, buffer("buf", cap))
            ids.insert(2, "buf")
        res = run_request(request(nodes, chain(*ids), horizon_h=60, replications=4))
        return float(metric(res, "throughput_per_hour")["mean"])

    assert th(10) > th(None) * 1.1


def test_disponibilidad_con_fallas_sobre_tiempo_de_operacion() -> None:
    # Ciclo 10 s, MTBF 1000 s de operación, MTTR 250 s fijo: A = 1000 / 1250 = 0.8.
    failures = {"mtbf_s": 1000, "mttr": {"type": "fixed", "value": 250}, "origin": "user"}
    req = request(
        [source("src", fixed(5)), station("st", fixed(10), failures=failures), sink("out", 100)],
        chain("src", "st", "out"),
        horizon_h=102,
        warmup_h=2,
        replications=4,
    )
    res = run_request(req)
    assert metric(res, "availability", "st")["mean"] == pytest.approx(80, abs=1.5)
    assert metric(res, "throughput_per_hour")["mean"] == pytest.approx(288, rel=0.02)
    assert metric(res, "oee", "st")["mean"] == pytest.approx(80, abs=1.5)


def test_scrap_calidad_y_oee() -> None:
    req = request(
        [
            source("src", fixed(1)),
            station("st", fixed(5), scrap={"rate": 0.1, "origin": "user"}),
            sink("out"),
        ],
        chain("src", "st", "out"),
        horizon_h=50,
        replications=3,
    )
    res = run_request(req)
    assert metric(res, "quality", "st")["mean"] == pytest.approx(90, abs=1.5)
    assert metric(res, "performance", "st")["mean"] == pytest.approx(100, abs=0.5)
    assert metric(res, "oee")["mean"] == pytest.approx(90, abs=1.5)  # línea = cuello de botella
    assert metric(res, "throughput_per_hour")["mean"] == pytest.approx(720 * 0.9, rel=0.02)
    assert metric(res, "scrap_units")["mean"] > 0


def test_ensamblaje_por_bom() -> None:
    bom = [{"item": "caja", "qty": 1}, {"item": "tapa", "qty": 2}]
    req = request(
        [
            source("cajas", fixed(4), item="caja"),
            source("tapas", fixed(1), item="tapa"),
            station("ens", fixed(5), operation="assemble"),
            sink("out"),
        ],
        [
            {"from": "cajas", "to": "ens"},
            {"from": "tapas", "to": "ens"},
            {"from": "ens", "to": "out"},
        ],
        bom=bom,
        replications=1,
    )
    res = run_request(req)
    # Las cajas llegan cada 4 s pero el ensamble tarda 5 s: manda la estación.
    assert metric(res, "throughput_per_hour")["mean"] == pytest.approx(720, abs=2)


def test_reparto_por_fracciones() -> None:
    req = request(
        [source("src", fixed(2)), sink("a", 1000), sink("b", 1000)],
        [{"from": "src", "to": "a", "share": 0.25}, {"from": "src", "to": "b", "share": 0.75}],
        horizon_h=20,
        replications=1,
    )
    res = run_request(req)
    assert metric(res, "throughput_per_hour")["mean"] == pytest.approx(1800, abs=2)


def test_cambio_de_pallet_detiene_la_salida() -> None:
    nodes = [source("src", fixed(1)), station("st", fixed(2)), sink("out", 10, change=fixed(20))]
    res = run_request(request(nodes, chain("src", "st", "out"), replications=1))
    # Cada pallet: 20 s de cambio + 9 unidades a 2 s (la décima se procesa durante el cambio
    # y espera bloqueada) = 38 s por pallet de 10.
    assert metric(res, "throughput_per_hour")["mean"] == pytest.approx(36000 / 38, rel=0.01)
    assert metric(res, "blocked", "st")["mean"] > 30


def test_reproducible_con_semilla() -> None:
    nodes = [source("src", expo(10)), buffer("b", 50), station("st", expo(8)), sink("out")]
    a = run_request(request(nodes, chain("src", "b", "st", "out"), seed=42))
    b = run_request(request(nodes, chain("src", "b", "st", "out"), seed=42))
    c = run_request(request(nodes, chain("src", "b", "st", "out"), seed=43))
    assert a["metrics"] == b["metrics"]
    assert a["events"] == b["events"]
    assert metric(a, "throughput_per_hour") != metric(c, "throughput_per_hour")


def test_takt_solo_con_demanda() -> None:
    nodes = [source("src", fixed(10)), station("st", fixed(5)), sink("out")]
    assert (
        run_request(request(nodes, chain("src", "st", "out"), replications=1))["summary"][
            "takt_time_s"
        ]
        is None
    )
    res = run_request(request(nodes, chain("src", "st", "out"), replications=1, demand=300))
    assert res["summary"]["takt_time_s"] == 12


def test_registro_de_eventos_en_la_ventana() -> None:
    nodes = [source("src", fixed(10)), station("st", fixed(5)), sink("out")]
    res = run_request(request(nodes, chain("src", "st", "out"), replications=2, window=120))
    ev = res["events"]
    assert ev["start_s"] == 3600
    assert ev["end_s"] == 3720
    assert all(3600 <= e[0] <= 3720 for e in ev["events"])
    kinds = {e[1] for e in ev["events"]}
    assert {"at", "gone", "st"} <= kinds
    assert {e[3] for e in ev["events"] if e[1] == "st"} <= {"busy", "idle", "blocked", "failed"}


def test_intervalo_de_confianza_contiene_la_media() -> None:
    nodes = [source("src", expo(10)), buffer("b", 1000), station("st", expo(7)), sink("out")]
    m = metric(
        run_request(request(nodes, chain("src", "b", "st", "out"), replications=5)),
        "throughput_per_hour",
    )
    assert m["ci_low"] < m["mean"] < m["ci_high"]
    assert m["min"] <= m["p5"] <= m["mean"] <= m["p95"] <= m["max"]
