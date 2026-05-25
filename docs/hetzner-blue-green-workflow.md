# Hetzner Blue-Green Workflow

This guide explains how to use the new deployment scaffolding in `infra/` so you can ship changes quickly on Hetzner without cutting off active users mid-call.

The repo now has two deployment layers:

- a base layer for long-lived services: Postgres and Redis
- a release layer for the versioned app stack: `web` and `server`

The current release tooling is built around two colors:

- `blue`
- `green`

Only one color is active for new users at a time, but the previous color can keep serving existing sessions while it drains.

## 1. Files Added For This Workflow

- `infra/podman-compose.base.yml`: long-lived Postgres and Redis stack
- `infra/podman-compose.release.yml`: versioned app release stack
- `infra/bin/start-base-stack.sh`: starts the base stack
- `infra/bin/deploy-release.sh`: deploys either the blue or green release
- `infra/nginx/sighthop-blue-green.conf`: host Nginx config for sticky release routing
- `infra/nginx/sighthop-active-release.conf`: include file that selects the default active release

## 2. What This Solves

This workflow gives you three things:

- a new release can boot and pass health checks before traffic shifts
- existing users can stay pinned to the old release during a drain window
- the old release can stop accepting new queue joins before it is shut down

The server now keeps live session, queue, encounter, and presence state in Redis so both release colors can observe the same match flow during a drain window.

## 3. Port Layout

The scripts default to these loopback-only ports on the Hetzner app VM:

- base Postgres: `127.0.0.1:5432`
- base Redis: `127.0.0.1:6379`
- blue server: `127.0.0.1:13000`
- blue web: `127.0.0.1:18080`
- green server: `127.0.0.1:23000`
- green web: `127.0.0.1:28080`

You can override them through env vars if needed.

## 4. Prepare The Production Env File

Create `infra/.env.production` on the app VM with at least:

```sh
CLIENT_ORIGIN=https://app.example.com
POSTGRES_USER=CHANGE_POSTGRES_USER
POSTGRES_PASSWORD=CHANGE_DB_PASSWORD
POSTGRES_DB=CHANGE_DB_NAME
STUN_SERVER_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_SERVER_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_USERNAME=CHANGE_TURN_USERNAME
TURN_PASSWORD=CHANGE_TURN_PASSWORD
DEPLOY_ADMIN_TOKEN=CHANGE_DEPLOY_ADMIN_TOKEN
```

If you want to override host ports, you can also add:

```sh
BLUE_SERVER_HOST_PORT=13000
BLUE_WEB_HOST_PORT=18080
GREEN_SERVER_HOST_PORT=23000
GREEN_WEB_HOST_PORT=28080
```

## 5. Start The Base Stack Once

On the Hetzner app VM:

```sh
cd /opt/SightHop
chmod +x infra/bin/*.sh
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/start-base-stack.sh
```

This starts the shared Postgres and Redis services that both release colors use.

## 6. Install The Host Nginx Config

Copy the sample config into the host Nginx config directory and edit the real hostname:

```sh
cp /opt/SightHop/infra/nginx/sighthop-blue-green.conf /etc/nginx/conf.d/sighthop.conf
cp /opt/SightHop/infra/nginx/sighthop-active-release.conf /etc/nginx/conf.d/sighthop-active-release.conf
```

Then edit `/etc/nginx/conf.d/sighthop.conf` and replace `app.example.com` with your real hostname.

Validate and reload:

```sh
nginx -t
systemctl reload nginx
```

This host config uses a `sighthop_release` cookie so existing users stay on the same release color while new users move to the current default color.

## 7. First Release Deployment

Deploy `blue` first:

```sh
cd /opt/SightHop
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/deploy-release.sh blue
```

What the script does:

1. Builds and starts the release stack for that color.
2. Waits for `/api/health` on the release server port.
3. Switches the default active release in the host Nginx include.
4. Reloads Nginx.

At this point all new traffic goes to `blue`.

## 8. Deploy A New Version Without Dropping Active Users

When you have a new change to ship:

```sh
cd /opt/SightHop
git pull
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/deploy-release.sh green --drain-old
```

If `blue` is live, this does the following:

1. Boots `green`.
2. Waits for `green` health to pass.
3. Flips new traffic to `green`.
4. Calls `POST /api/admin/drain/start` on `blue` using `DEPLOY_ADMIN_TOKEN`.
5. Polls `blue` until its queue size and active encounter count reach zero.
6. Stops the old `blue` release.

The next deployment simply swaps the colors.

## 9. How Drain Mode Works

The server now has a deployment drain mode.

When drain mode is enabled on the old release:

- `POST /api/session` returns `503`
- new `queue:join` socket events are rejected with a user-visible error message
- existing connections and active encounters are left alone
- `/api/health` reports `deployment.draining`, `deployment.queueSize`, and `deployment.activeEncounterCount`

Because those counts now come from shared Redis-backed live state, they stay accurate even while both release colors are running.

## 10. Operational Rules

If you want this workflow to stay stable, keep these rules:

- deploy only backward-compatible changes while the old and new colors coexist
- do not stop the old release until drain reaches zero or you intentionally force the cutover
- keep `DEPLOY_ADMIN_TOKEN` private and set only on the app VM
- keep Postgres and Redis long-lived; do not rebuild them on every release

## 11. What Still Causes User Disruption Today

This workflow is substantially more robust now that live state is shared through Redis, but it still has limits.

The current limitations are:

- if you deploy a breaking protocol change, old and new clients may disagree during the drain window
- if the host VM itself goes down, both release colors and the in-memory live state go with it
- if the host VM itself goes down, both release colors and the Redis-backed live state on that VM go with it

For zero-downtime infrastructure failures or larger horizontal scaling, you would still move Redis off-box and harden cross-instance signaling further.