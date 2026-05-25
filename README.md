# SightHop MVP

SightHop is a web-first MVP for a P2P swipe-to-video app. Guests create a lightweight session profile, join a matching queue, swipe on one presented person at a time, and start direct WebRTC video after mutual right swipes.

## Apps

- `apps/web`: React + Vite browser client.
- `apps/server`: Fastify + Socket.IO API and signaling server.
- `packages/shared`: shared schemas, event names, and types.
- `infra`: Docker Compose for a single-VPS deployment shape.

## Local Development

```sh
npm install
cp .env.example .env
npm run build --workspace @sighthop/shared
npm run dev --workspace @sighthop/server
npm run dev --workspace @sighthop/web
```

The browser app defaults to `http://localhost:5173` and the API defaults to `http://localhost:3000`.

## Podman Deployment Smoke Test

```sh
podman machine init
podman machine start
podman-compose -f infra/podman-compose.yml up --build
```

The composed web service listens on `http://localhost:8080` and proxies API and Socket.IO traffic to the server container.

## Deployment Guides

- [Hetzner blue-green workflow](docs/hetzner-blue-green-workflow.md)
- [Hetzner single-VM starter guide](docs/hetzner-single-vm-deployment.md)
- [Hetzner VM deployment guide](docs/hetzner-vm-deployment.md)
- [Redis live-state migration sketch](docs/redis-live-state-plan.md)

## WebRTC Policy

The app defaults to STUN/direct peer-to-peer WebRTC. TURN relay is optional and should be enabled as a production fallback so restrictive networks can still connect without forcing relay for every call.

## TURN Fallback

The signaling server now builds the client ICE server list from environment variables:

```sh
STUN_SERVER_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_SERVER_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_USERNAME=sighthop
TURN_PASSWORD=replace-me
```

Notes:

- `STUN_SERVER_URLS` is optional. If unset, the server keeps the built-in Google STUN defaults.
- `TURN_SERVER_URLS` is optional. If unset, the app remains STUN-only.
- If `TURN_SERVER_URLS` is set, `TURN_USERNAME` and `TURN_PASSWORD` are required.
- TURN URLs must use a public hostname or IP that browsers can reach. Do not use a private container hostname.

## Hetzner Deployment Shape

For a low-cost production setup on Hetzner:

- Run the web app, API, and Socket.IO signaling on one small VM behind HTTPS.
- Run `coturn` on a second small VM or on a public IP that is reachable over UDP/TCP 3478.
- Keep TURN as fallback only by advertising both STUN and TURN servers; ICE will prefer direct paths when possible.
- Point `TURN_SERVER_URLS` at the public TURN hostname, not the internal compose service name.

The sample `infra/podman-compose.yml` now accepts the TURN env vars above and can start an optional `coturn` container with `podman-compose --profile turn up`, but production browsers still need a public TURN hostname to use it.
