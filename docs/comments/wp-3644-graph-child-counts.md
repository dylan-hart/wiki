# WP 3644 recommended comments

- `frontend/src/pages/Graph.vue`, above `childCountAccessor()`: "Rebuilt from `edges.value` on every call, never cached: d3-force evaluates `link.distance()` at attach time and the visible edge set changes."
- `frontend/src/pages/Graph.filters.test.js`, above `docsPage`: the simulation's edges are all synthesized path-hierarchy edges, so the parent is the synthetic `docs` folder.
- Same file, above `idOf`: an edge endpoint is an id string until d3-force resolves it to the node object.
