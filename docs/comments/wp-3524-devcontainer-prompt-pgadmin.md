# WP 3524: devcontainer prompt no-op and pgAdmin servers.json

Both marker comments describe a defect this work package fixes; each is now stale.

## `.devcontainer/Dockerfile`

Delete the two-line `# FIXME: colorizes root's prompt, ...` comment above `COPY wait-for.sh`. The
`sed` on `/root/.bashrc` it flagged is removed: the container runs as `node` with zsh as the default
terminal profile, so the edit never reached a developer's shell.

## `.devcontainer/docker-compose.yml`

Delete the two-line `# TODO: mount ./pgadmin-servers.json at /pgadmin4/servers.json; ...` comment at
the end of the `pgadmin` service. The bind mount is now in place.
