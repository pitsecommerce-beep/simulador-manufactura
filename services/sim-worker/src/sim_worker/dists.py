"""Muestreo de distribuciones (segundos, nunca negativas)."""

from __future__ import annotations

import math
import random

from sim_worker.model import (
    Distribution,
    Exponential,
    Fixed,
    LogNormal,
    Normal,
    Triangular,
    Uniform,
)


def sample(d: Distribution, rng: random.Random) -> float:
    if isinstance(d, Fixed):
        return d.value
    if isinstance(d, Exponential):
        return rng.expovariate(1 / d.mean)
    if isinstance(d, Normal):
        # Normal truncada en 0: un tiempo no puede ser negativo.
        return max(0.0, rng.gauss(d.mean, d.sd))
    if isinstance(d, LogNormal):
        # Parámetros de la lognormal a partir de la media y la desviación de la variable.
        sigma2 = math.log(1 + (d.sd / d.mean) ** 2)
        mu = math.log(d.mean) - sigma2 / 2
        return rng.lognormvariate(mu, math.sqrt(sigma2))
    if isinstance(d, Uniform):
        return rng.uniform(d.min, d.max)
    if isinstance(d, Triangular):
        return rng.triangular(d.min, d.max, d.mode)
    raise TypeError(f"distribución desconocida: {d!r}")


def mean(d: Distribution) -> float:
    if isinstance(d, Fixed):
        return d.value
    if isinstance(d, Exponential | Normal | LogNormal):
        return d.mean
    if isinstance(d, Uniform):
        return (d.min + d.max) / 2
    if isinstance(d, Triangular):
        return (d.min + d.mode + d.max) / 3
    raise TypeError(f"distribución desconocida: {d!r}")
