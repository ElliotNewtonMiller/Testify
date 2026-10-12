# Deploying Testify

Testify is one Node.js process that serves the API, the MCP endpoint (`/mcp`) and the web app on one port, on top of PostgreSQL. Database migrations run automatically at startup.

**Requirements**:
- PostgreSQL (tested with 17).
- Node.js 22 or newer, or Docker.

## With Docker Compose

`docker-compose.yml` runs Testify and PostgreSQL together, with the database kept in a Docker volume.

1. `cp .env.example .env`, then fill in `POSTGRES_PASSWORD` and `JWT_SECRET`. Generate each with `openssl rand -hex 32`. Also set `SECRETS_KEY` if you'll send email.
2. `docker compose up -d`
3. `docker compose logs testify` shows the first admin's password. Sign in at http://localhost:3001 as `admin`; you'll be asked to choose a new password.

Testify listens on port 3001; set `TESTIFY_PORT` in `.env` to use another port on the host. To upgrade, pull the new code and run `docker compose up -d --build`.

The image (`Dockerfile`) works on its own too:

```bash
docker build -t testify .
docker run -p 3001:3001 -e DATABASE_URL=... -e JWT_SECRET=... testify
```

It runs as the unprivileged `node` user, and Docker checks its health through `GET /api/v1/health`.

## Without Docker

```bash
npm ci
npm run build    # apps/web/dist and apps/server/dist/server.js
DATABASE_URL=postgres://testify:secret@db.example.com:5432/testify \
JWT_SECRET=<32+ random characters> \
NODE_ENV=production \
npm start
```

`npm start` runs `node apps/server/dist/server.js`. It needs the repository's `node_modules` (`npm ci --omit=dev` is enough at run time) and `apps/web/dist`. Run it under a process manager such as systemd, and restart it if it exits.

## Configuration

All configuration comes from environment variables; nothing reads a `.env` file except Docker Compose. A value that's wrong stops the server at startup, with a message saying what to set.

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | none (required) | `postgres://user:password@host:5432/database`. Development only: `memory` for a throwaway in-memory database. |
| `JWT_SECRET` | none (required) | Signs sign-ins. At least 32 characters. Must be the same on every instance and must not change, or everyone is signed out. |
| `SECRETS_KEY` | none | Encrypts the SMTP password saved in Admin Panel → Email. At least 32 characters. Without it, no SMTP password can be saved. If it changes, the password must be entered again. |
| `ADMIN_PASSWORD` | generated | The first admin's password, used only when the database has no users. Unset, a random one is printed once in the log and must be changed at first sign-in. |
| `PORT` | `3001` | The port to listen on. |
| `NODE_ENV` | | Set to `production` to refuse `DATABASE_URL=memory`. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so client addresses and HTTPS come from its `X-Forwarded-*` headers. |
| `CORS_ORIGINS` | none | Only needed if the web app is served from a different address than the API: a comma-separated list of exact origins. |
| `LOG_LEVEL` | `info` | `info` logs one JSON line per request. `warn` and `error` log only problems; `silent` logs nothing. |
| `WEB_DIST_DIR` | `apps/web/dist` | Where the built web app is. If there's no build, only the API is served. |
| `SEED_SAMPLE_DATA` | `false` | `true` creates a small sample project. |

## HTTPS and reverse proxies

Put Testify behind a reverse proxy (nginx, Caddy, Traefik, a cloud load balancer) that handles HTTPS. Then:

- **Set `TRUST_PROXY=true`.** Sign-in limits then see real client addresses, the audit log records them, and the session cookie is marked `Secure`.
- **Allow large uploads.** Imports can be up to 50 MB; with nginx, set `client_max_body_size 60m;`.
- **Set the address used in emails.** In Admin Panel → Email, set "Testify address for links in emails" to the public address, e.g. `https://testify.example.com`.

The session cookie is `SameSite=Strict`, so serve the web app and the API from the same site. The built-in serving of the web app does that.

## Health and logs

- **Health:** `GET /api/v1/health` needs no sign-in. It returns 200 while the server and its database are up, and 503 otherwise. Point load balancers and uptime monitors at it.
- **Logs:** everything goes to stdout and stderr. Each request is one JSON line with its id, method, address, status, time taken and who made it; headers and request bodies are never logged.
- **Tracing an error:** every reply carries an `X-Request-Id` header. An unexpected error's reply shows the same id, so you can find its log line.

## Backups and upgrades

- **Backups:** all data is in PostgreSQL. Back it up with `pg_dump`, e.g. `docker compose exec db pg_dump -U testify testify > testify.sql`. Keep `JWT_SECRET` and `SECRETS_KEY` somewhere safe too; they aren't in the database.
- **Upgrades:** stop Testify, back up the database, then start the new version. Pending migrations run at startup, and a failed one stops the server with its name. Migrations only move forward; to go back to an older version, restore the backup.

## More than one instance

Several instances can share one database if they share `JWT_SECRET` and `SECRETS_KEY`. Scheduled report emails are claimed atomically, so none is sent twice. Some limits are counted per instance, so with N instances they're effectively N times higher:
- sign-in attempts per address;
- API token, export and email rate limits;
- at most 2 imports at a time.

Account lockouts are stored in the database and apply across all instances.

## Security checklist

- Strong, unique `JWT_SECRET`, `SECRETS_KEY` and database password, kept out of version control (`.env` is git-ignored).
- HTTPS in front, with `TRUST_PROXY=true`.
- Change the first admin's password at first sign-in. Testify asks for it when it generated the password.
- PostgreSQL reachable only from Testify, not from the internet.
- Regular database backups, restored at least once to check they work.
