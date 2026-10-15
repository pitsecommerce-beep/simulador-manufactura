"""Escritura de resultados en Supabase por HTTPS (PostgREST y Storage) con la clave secreta.

No usa conexión directa a Postgres: el servicio no tiene DATABASE_URL.
"""

from __future__ import annotations

from typing import Any, Protocol

import httpx

BUCKET = "sim-artifacts"


class ResultWriter(Protocol):
    def update_run(self, run_id: str, fields: dict[str, Any]) -> None: ...
    def insert_metrics(self, rows: list[dict[str, Any]]) -> None: ...
    def upload_events(self, path: str, data: bytes) -> None: ...


class SupabaseWriter:
    def __init__(self, url: str, secret_key: str, client: httpx.Client | None = None) -> None:
        headers = {"apikey": secret_key}
        # Las claves heredadas (service_role) son JWT y también van en Authorization.
        # Las claves nuevas (sb_secret_...) solo van en `apikey`.
        if secret_key.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {secret_key}"
        self.base = url.rstrip("/")
        self.http = client or httpx.Client(timeout=30)
        self.http.headers.update(headers)

    def _check(self, res: httpx.Response) -> None:
        if res.status_code >= 300:
            where = f"{res.request.method} {res.request.url.path}"
            raise RuntimeError(f"Supabase {where}: {res.status_code} {res.text[:300]}")

    def update_run(self, run_id: str, fields: dict[str, Any]) -> None:
        res = self.http.patch(
            f"{self.base}/rest/v1/simulation_runs",
            params={"id": f"eq.{run_id}"},
            json=fields,
            headers={"Prefer": "return=minimal"},
        )
        self._check(res)

    def insert_metrics(self, rows: list[dict[str, Any]]) -> None:
        for i in range(0, len(rows), 500):
            res = self.http.post(
                f"{self.base}/rest/v1/simulation_metrics",
                json=rows[i : i + 500],
                headers={"Prefer": "return=minimal"},
            )
            self._check(res)

    def upload_events(self, path: str, data: bytes) -> None:
        res = self.http.post(
            f"{self.base}/storage/v1/object/{BUCKET}/{path}",
            content=data,
            headers={"Content-Type": "application/gzip", "x-upsert": "true"},
        )
        self._check(res)
