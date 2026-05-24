# LocalChat MVP

LocalChat is a web-first MVP for a P2P swipe-to-video app. Guests create a lightweight session profile, join a matching queue, swipe on one presented person at a time, and start direct WebRTC video after mutual right swipes.

## Apps

- `apps/web`: React + Vite browser client.
- `apps/server`: Fastify + Socket.IO API and signaling server.
- `packages/shared`: shared schemas, event names, and types.
- `infra`: Docker Compose for a single-VPS deployment shape.

## Local Development

```sh
npm install
cp .env.example .env
npm run build --workspace @localchat/shared
npm run dev --workspace @localchat/server
npm run dev --workspace @localchat/web
```

The browser app defaults to `http://localhost:5173` and the API defaults to `http://localhost:3000`.

## Podman Deployment Smoke Test

```sh
podman machine init
podman machine start
podman-compose -f infra/podman-compose.yml up --build
```

The composed web service listens on `http://localhost:8080` and proxies API and Socket.IO traffic to the server container.

## WebRTC Policy

The MVP uses STUN/direct peer-to-peer WebRTC only. No TURN relay is enabled by default, so some networks will fail to connect and the UI will offer a graceful requeue path.
