<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://static.requarks.io/logo/wikijs-full-darktheme.svg">
  <img alt="Wiki.js" src="https://static.requarks.io/logo/wikijs-full.svg" width="600">
</picture>

[![License](https://img.shields.io/badge/license-AGPLv3-blue.svg?style=flat)](https://github.com/requarks/wiki/blob/master/LICENSE)
[![Standard - JavaScript Style Guide](https://img.shields.io/badge/code%20style-standard-green.svg?style=flat&logo=javascript&logoColor=white)](http://standardjs.com/)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/ngpixel?logo=github&color=ea4aaa)](https://github.com/users/NGPixel/sponsorship)
[![Open Collective backers and sponsors](https://img.shields.io/opencollective/all/wikijs?label=backers&color=218bff&logo=opencollective&logoColor=white)](https://opencollective.com/wikijs)

##### Next Generation Open Source Wiki

</div>

- **[Official Website](https://beta.js.wiki)**
- **[Documentation](https://beta.js.wiki/docs)**
- **[Operations Guide](docs/operations.md)** — backup/restore scope and container mounts
- **[MCP Getting Started](docs/mcp-getting-started.md)** — connect an LLM agent via the built-in
  Model Context Protocol server

:red_square: :warning: :warning: :red_square:  
**THIS IS A VERY BUGGY, INCOMPLETE AND NON-SECURE DEVELOPMENT BRANCH!**  
**USE AT YOUR OWN RISK! THERE'S NO UPGRADE PATH FROM THIS BUILD AND NO SUPPORT IS PROVIDED!**  
:red_square: :warning: :warning: :red_square:

The current stable release (2.x) is available at https://js.wiki

---

- [Using VS Code Dev Environment](#using-vs-code-dev-environment) _(recommended)_
  - [Requirements](#requirements)
  - [Usage](#usage)
  - [Backend Development](#backend-development)
  - [Backend Tests](#backend-tests)
  - [Frontend Development](#frontend-development)
  - [pgAdmin](#pgadmin)
- [Generic Setup](#generic-setup)
  - [Requirements](#requirements-1)
  - [Usage](#usage-1)
- [First-Run Admin Account](#first-run-admin-account)
- [Repository Documentation](#repository-documentation)

## Using VS Code Dev Environment

### Requirements

- [VS Code](https://code.visualstudio.com/)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- **Windows-only:** [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) + [WSL Integration](https://docs.docker.com/desktop/wsl/) enabled in Docker Desktop

### Usage

1. Clone the project.
1. Open the project in VS Code.
1. Make sure you have **Dev Containers** extension installed. (On Windows, you need the **WSL** VS Code extension as well.)
1. Reopen the project in container (from the popup in the lower-right corner of the screen when opening the project, or via the Command Palette (Ctrl+Shift+P _or_ F1) afterwards).
1. Once in container mode, make a copy of `config.sample.yml` and rename it to `config.yml`. There's no need to edit the file, the default values are ok.
1. Two terminals should automatically launch in the lower part of the screen. If this isn't the case, from the Command Palette, run the task "Create terminals":
   - Launch the Command Palette (Ctrl+Shift+P _or_ F1)
   - Type `Run Task` and press <kbd>Enter</kbd>
   - Select the task "Create terminals" and press Enter
1. In the right-side terminal (Frontend), run the command:
   ```sh
   npm run build
   ```
1. In the left-side terminal (Backend), run the command:
   ```sh
   npm run start
   ```
1. Open your browser to `http://localhost:3000`
1. Login using the default administrator user:
   - Email: `admin@example.com`
   - Password: `12345678`

> **DO NOT** report bugs. This build is **VERY** buggy and **VERY** incomplete. Absolutely **NO** support is provided either.

### Backend Development

From the left-side terminal (Backend), run the command:

```sh
npm run dev
```

This will launch the server and automatically restart upon modification of any server files.

Only precompiled client assets are served in this mode. See the sections below on how to modify the frontend and run in SPA (Single Page Application) mode.

### What the dev container is

It is not merely a convenient place to work — it is built to be the same environment
`.github/workflows/` runs the quality gate on, so that "it passes here" and "it passes in CI" mean
the same thing. Concretely, it pins Node to a single exact patch (`.devcontainer/Dockerfile`'s
`ARG NODE_VERSION`, the only place any Node version is named), runs the same `postgres:18`, and bakes
in every tool a workflow installs onto its runner before it can run the gate: pandoc, git-cliff at
the same pinned release, and the Chromium revision the `playwright` package expects — so neither
`e2e/` nor `frontend/`'s two real-layout suites need a per-machine `npm run install-browsers`. Git is
configured explicitly rather than inherited from your host, so a test can never pass here and fail in
CI on an ambient `init.defaultBranch`.

Bumping Node therefore means editing `.devcontainer/Dockerfile`'s `NODE_VERSION` *and*
`NODE_IMAGE_DIGEST` *and* every `node-version:` in `.github/workflows/*.yml`, in one commit. The image
build fails if the first two disagree, and `backend/test/devcontainerCiParity.test.ts` guards the rest.

### Backend Tests

The `app` container's `DATABASE_URL` (set in `.devcontainer/docker-compose.yml`) points at the same
`db` container the app itself connects to, using `config.sample.yml`'s own db defaults. This means:

- `npm run test` in `backend/` runs the DB-backed suites (see this repo's `CLAUDE.md`, "Testing
  (backend)" section) in addition to the pure-unit ones, instead of silently skipping them.
- `npm run dev` / `npm run start` are unaffected, as long as `config.yml`'s `db:` block is left at
  its default values.

If you edit `config.yml`'s `db:` block to point somewhere else, `DATABASE_URL` still wins over it --
`unset DATABASE_URL` in your own terminal first, since `core/db.ts` prefers `DATABASE_URL` outright
over `WIKI.config.db.*` whenever it's set.

### Frontend Development

> Make sure you are running `npm run dev` in the left-side terminal (Backend) first! Requests still need to be forwarded to the server, even in SPA mode!

If you wish to modify any frontend content (under `/frontend`), you need to start the Vite dev server in the right-side terminal (Frontend):

```sh
npm run dev
```

You can then access the site at `http://localhost:3001`. Notice the port being `3001` rather than `3000`. The app runs in a SPA (single-page application) mode and automatically hot-reload any modified component. Any requests made to the `/_api` endpoint are automatically forwarded to the server running on port `3000`, which is why both must be running at the same time.

Any change you make to the frontend will not be reflected on port 3000 until you run the command `npm run build` in the right-side terminal.

### pgAdmin

pgAdmin is **not started by default** — it sits behind the `tools` docker-compose profile, because
the dev container is meant to be exactly what CI runs on and CI has no pgAdmin. Start it explicitly:

```sh
docker compose --profile tools up -d pgadmin   # from .devcontainer/
```

A web version of pgAdmin (a PostgreSQL administration tool) is then available at `http://localhost:8000`. Use the login `dev@js.wiki` / `123123` to login.

Add a new server under **Servers** with the following settings:

- Hostname: `db`
- Port: `5432`
- Username: `postgres`
- Password: `postgres`
- Database: `postgres`

## Generic Setup

### Requirements

- PostgreSQL **16** or later
- Node.js **26.x** or later

### Usage

1. Clone the project
1. Run `./dev/setup.sh` from the repo root. It installs dependencies for all four workspaces
   (`backend`, `frontend`, `blocks`, `e2e`), creates `config.yml` from `config.sample.yml` if one
   doesn't already exist, and builds `frontend` and `blocks`. It's safe to re-run at any time —
   it won't overwrite an existing `config.yml`. Equivalently, by hand: `cd backend && npm install`,
   `cd frontend && npm install && npm run build`, `cd blocks && npm install && npm run build`.
1. Edit `config.yml` and fill in the database details. **You need an empty PostgreSQL database.**
1. Run this command, **from the repository root** (not from inside `backend/`), to start the server:
   ```sh
   node backend
   ```
1. In your browser, navigate to `http://localhost:3000` _(or the IP/hostname of the server and the PORT you defined earlier.)_
1. Login using the default administrator user:
   - Email: `admin@example.com`
   - Password: `12345678`

> **DO NOT** report bugs. This build is **VERY** buggy and **VERY** incomplete. Absolutely **NO** support is provided either.

There is also an `e2e/` workspace holding the Playwright end-to-end suite, which drives a full build
of the stack and requires its own `DATABASE_URL` — see [`CLAUDE.md`](CLAUDE.md#testing-e2e) for how
to point it at a database.

## First-Run Admin Account

The `admin@example.com` / `12345678` login shown above is only the _default_ — it's what gets seeded
when nothing else is specified. On first boot against an **empty** (unseeded) database, the server
reads two environment variables to seed the admin account instead:

- `ADMIN_EMAIL` — the admin account's email, in place of `admin@example.com`.
- `ADMIN_PASS` — the admin account's password, in place of `12345678`. Setting this also skips the
  forced "you must change your password" flow that the default seed always triggers on first login,
  so a Docker Compose deployment can set both and land straight in an authenticated, already-secured
  instance.

Both are read once, at first-run seeding time only — they have no effect on a database that already
has a `settings` row (i.e. any instance that has already booted once), so there is no way to use them
to reset a lost admin password on a running instance.

## Repository Documentation

Beyond this file, the repo-checked-in documentation lives in two places:

- **[`CLAUDE.md`](CLAUDE.md)** — the repo's own layout, conventions and workspace-by-workspace
  developer guide (routing, permissions model, testing setup per workspace, TypeScript rules, etc.).
- **[`docs/`](docs)** — deeper reference material, including
  **[`docs/operations.md`](docs/operations.md)** (backup scope, restore order, upgrading a running
  instance, and troubleshooting), **[`docs/offline-deployment.md`](docs/offline-deployment.md)**
  (air-gapped setup), and **[`docs/migration/migration-runbook.md`](docs/migration/migration-runbook.md)**
  (the one-time 2.5.x → 3.0 cutover).
