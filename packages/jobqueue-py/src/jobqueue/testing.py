"""Utilidades de test: crea una base desechable con el stub de Supabase y las migraciones."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[4]
ADMIN_URL = os.environ.get(
    "TEST_DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/postgres"
)


@contextmanager
def temporary_database() -> Iterator[str]:
    name = f"sim_pytest_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
        admin.execute(f"create database {name}")
    url = ADMIN_URL.rsplit("/", 1)[0] + f"/{name}"
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute((REPO_ROOT / "supabase/tests/supabase-stub.sql").read_text())
            for f in sorted((REPO_ROOT / "supabase/migrations").glob("*.sql")):
                conn.execute(f.read_text())
        yield url
    finally:
        with psycopg.connect(ADMIN_URL, autocommit=True) as admin:
            admin.execute(f"drop database if exists {name} with (force)")
