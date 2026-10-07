"""Modelo de entrada del motor (contrato con la api: packages/domain/src/simulation.ts)."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _Base(BaseModel):
    model_config = ConfigDict(extra="ignore", frozen=True)


class Fixed(_Base):
    type: Literal["fixed"]
    value: float = Field(ge=0)


class Exponential(_Base):
    type: Literal["exponential"]
    mean: float = Field(gt=0)


class Normal(_Base):
    type: Literal["normal"]
    mean: float = Field(gt=0)
    sd: float = Field(ge=0)


class LogNormal(_Base):
    type: Literal["lognormal"]
    mean: float = Field(gt=0)
    sd: float = Field(ge=0)


class Uniform(_Base):
    type: Literal["uniform"]
    min: float = Field(ge=0)
    max: float = Field(ge=0)


class Triangular(_Base):
    type: Literal["triangular"]
    min: float = Field(ge=0)
    mode: float = Field(ge=0)
    max: float = Field(ge=0)


Distribution = Annotated[
    Fixed | Exponential | Normal | LogNormal | Uniform | Triangular, Field(discriminator="type")
]


class Timed(_Base):
    dist: Distribution
    origin: Literal["catalog", "user", "assistant"]
    note: str | None = None


class Scrap(_Base):
    rate: float = Field(ge=0, lt=1)
    origin: str


class Failures(_Base):
    mtbf_s: float = Field(gt=0)
    mttr: Distribution
    origin: str


class Source(_Base):
    role: Literal["source"]
    object_id: str
    name: str
    item: str
    interarrival: Timed
    batch: int = Field(default=1, ge=1)


class Station(_Base):
    role: Literal["station"]
    object_id: str
    name: str
    operation: Literal["process", "assemble"] = "process"
    cycle: Timed
    capacity: int = Field(default=1, ge=1)
    scrap: Scrap | None = None
    failures: Failures | None = None


class Buffer(_Base):
    role: Literal["buffer"]
    object_id: str
    name: str
    capacity: int = Field(ge=1)
    transfer: Timed | None = None


class Sink(_Base):
    role: Literal["sink"]
    object_id: str
    name: str
    units_per_pallet: int = Field(ge=1)
    pallet_change: Timed | None = None


Node = Annotated[Source | Station | Buffer | Sink, Field(discriminator="role")]


class BomLine(_Base):
    item: str
    qty: int = Field(ge=1)


class Product(_Base):
    name: str
    bom: list[BomLine] = []


class Route(_Base):
    from_: str = Field(alias="from")
    to: str
    item: str | None = None
    share: float | None = None


class SimModel(_Base):
    product: Product
    nodes: list[Node]
    routes: list[Route]

    @model_validator(mode="after")
    def _routes_reference_nodes(self) -> SimModel:
        ids = {n.object_id for n in self.nodes}
        for r in self.routes:
            if r.from_ not in ids or r.to not in ids:
                raise ValueError(f"ruta {r.from_} -> {r.to} apunta a un nodo inexistente")
        return self


class RunConfig(_Base):
    name: str
    horizon_h: float = Field(gt=0)
    warmup_h: float = Field(default=0, ge=0)
    replications: int = Field(ge=1)
    seed: int = Field(ge=0)
    demand_per_hour: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def _warmup_lt_horizon(self) -> RunConfig:
        if self.warmup_h >= self.horizon_h:
            raise ValueError("el calentamiento debe ser menor que el horizonte")
        return self


class SimRequest(_Base):
    run_id: str
    project_id: str
    model: SimModel
    config: RunConfig
    playback_window_s: float = Field(default=1800, gt=0)
    max_events: int = Field(default=200_000, ge=0)
    # Supuestos del modelo (los calcula la api) para guardarlos junto a los resultados.
    assumptions: list[str] = []
