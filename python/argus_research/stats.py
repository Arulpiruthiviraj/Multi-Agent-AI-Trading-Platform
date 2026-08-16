"""Research statistics. DSR penalizes multiple testing; not a live sizing input."""
from __future__ import annotations

import math


def _phi(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _inv_phi(p):
    if p <= 0.0:
        return -8.0
    if p >= 1.0:
        return 8.0
    lo, hi = -8.0, 8.0
    for _ in range(80):
        mid = (lo + hi) / 2.0
        if _phi(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def sharpe_from_pnls(pnls):
    n = len(pnls)
    if n < 2:
        return None
    mean = sum(pnls) / n
    var = sum((p - mean) ** 2 for p in pnls) / n
    stdev = math.sqrt(var)
    if stdev <= 0:
        return None
    return mean / stdev


def deflated_sharpe(sr, n_obs, n_trials, skew=0.0, kurtosis=3.0, sr_benchmark=0.0):
    """Bailey & López de Prado DSR (normal approx). Returns None if under-defined."""
    if sr is None or n_obs < 3 or n_trials < 1:
        return None
    gamma = 0.5772156649
    se = math.sqrt((1 - skew * sr + ((kurtosis - 1) / 4.0) * (sr ** 2)) / (n_obs - 1))
    if se <= 0 or not math.isfinite(se):
        return None
    sr0 = se * ((1 - gamma) * _inv_phi(1 - 0.05) + gamma * _inv_phi(1 - 0.05 / n_trials))
    z = (sr - sr_benchmark - sr0) / se
    if not math.isfinite(z):
        return None
    return _phi(z)


def permutation_positive_expectancy(pnls, alpha, rng_seed=1, rounds=200):
    if len(pnls) < 5:
        return False
    import random
    rng = random.Random(rng_seed)
    obs = sum(pnls) / len(pnls)
    beats = 0
    for _ in range(rounds):
        shuffled = list(pnls)
        rng.shuffle(shuffled)
        if (sum(shuffled) / len(shuffled)) >= obs:
            beats += 1
    p = beats / rounds
    return p <= alpha
