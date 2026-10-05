# Implementation: S-Curve Sizing Primitive (2026-10-05)

## Status
IMPLEMENTED - pure math, no production caller.

## What was built
- `quant-core-java/.../risk/MetaLabelSizing.java` - `size(p) = 2*Phi((p-0.5)/sqrt(p*(1-p))) - 1`
- 8 unit tests: zero at p=0.5, monotonicity, symmetry, bounds, input validation

## Properties verified
- p=0.5 -> 0 (no edge, no bet)
- Monotonic increasing in p
- Symmetric: size(0.4) = -size(0.6)
- Bounded in [-1, 1]
- Rejects NaN, infinite, and out-of-(0,1) inputs

## What's NOT built
- Any integration with PositionSizing or the OMS
- The meta-model that would produce p
- Calibration of p

## Activation gate
This function must not be called from any live path until: (1) a meta-model exists,
(2) it is calibrated on sufficient PAPER labels, (3) the integration passes its own
review. The JavaDoc states this explicitly.
