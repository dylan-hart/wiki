# frontend/src/pages/graphForces.js

- The comment above `RING_RADIUS_STEP` says each ring pushes outward by that amount. It is now the ceiling: `ringRadiusStepFor(childCount)` shrinks it by `childCountTermFor(childCount)` (the child-count link term already in the spoke), floored at `RING_RADIUS_MIN_STEP`. Suggested: "Upper bound on the per-ring outward push; `ringRadiusStepFor` reduces it by the child-count spoke term so the two do not double-count a large family."
