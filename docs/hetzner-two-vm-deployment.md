# Hetzner VM Deployment Guide

This guide walks through a production-style deployment of LocalChat on Hetzner Cloud using two Ubuntu VMs:

- one app VM for the web app, API, Socket.IO signaling, Postgres, and Redis
- one TURN VM for coturn so restrictive networks can fall back to relay

This setup keeps costs low, matches the current repository layout, and stays portable if you move away from Hetzner later.

## 1. What You Are Building

At the end of this guide you will have:

- `https://app.example.com` serving the LocalChat web app
- the app VM running the repo's existing `podman-compose` stack
- `turn.example.com` running coturn for TURN fallback
- TLS on the app domain so camera and microphone access work in browsers

Suggested starting size:

- app VM: 2 vCPU, 4 GB RAM
- TURN VM: 2 vCPU, 2 GB RAM

You can start smaller if traffic is tiny, but this is a safer first public setup.

## 2. Prerequisites

Before you begin, have these ready:

- a Hetzner Cloud account
- a domain name you control
- an SSH key added to Hetzner Cloud
- this repository pushed to GitHub or otherwise reachable from the VM

You also need to pick two hostnames:

- `app.example.com` for the website
- `turn.example.com` for the TURN server

## 3. Create The VMs In Hetzner

In the Hetzner Cloud console:

1. Create an Ubuntu 24.04 VM for the app.
2. Create a second Ubuntu 24.04 VM for TURN.
3. Attach your SSH key to both VMs.
4. Put both VMs in the same region.
5. Note both public IPv4 addresses.

Name them something obvious, for example:

- `localchat-app-prod`
- `localchat-turn-prod`

## 4. Configure DNS

Create these DNS records with your domain provider:

- `A app.example.com -> APP_VM_PUBLIC_IP`
- `A turn.example.com -> TURN_VM_PUBLIC_IP`

Wait for DNS to resolve before you request TLS certificates.

## 5. Configure Firewall Rules

You can use Hetzner Cloud Firewalls, `ufw` on the VM, or both. The minimum public ports are:

For the app VM:

- `22/tcp` for SSH
- `80/tcp` for HTTP certificate issuance and redirects
- `443/tcp` for HTTPS

For the TURN VM:

- `22/tcp` for SSH
- `3478/tcp` for TURN over TCP
- `3478/udp` for TURN over UDP
- `49160-49200/udp` for relayed media

That UDP range is intentionally small for an early deployment. If you later support more concurrent relayed calls, widen it.

## 6. Initial Setup On The App VM

SSH into the app VM:

```sh
ssh root@app.example.com
```

Install the base packages:

```sh
apt update && apt upgrade -y
apt install -y git podman podman-compose nginx certbot python3-certbot-nginx
systemctl enable --now nginx
```

Clone the repository:

```sh
cd /opt
git clone https://github.com/YOUR_GITHUB_USERNAME/LocalChat.git
cd LocalChat
```

Create a production env file for the compose stack:

```sh
cat > /opt/LocalChat/infra/.env.production <<'EOF'
NODE_ENV=production
PORT=3000
CLIENT_ORIGIN=https://app.example.com
DATABASE_URL=postgres://localchat:CHANGE_DB_PASSWORD@postgres:5432/localchat
REDIS_URL=redis://redis:6379
STUN_SERVER_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_SERVER_URLS=
TURN_USERNAME=
TURN_PASSWORD=
EOF
```

Replace `CHANGE_DB_PASSWORD` with a strong password.

## 7. Start The App Stack

From the repo root on the app VM:

```sh
cd /opt/LocalChat
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml up -d --build
```

Check that the containers are running:

```sh
podman ps
podman-compose -f infra/podman-compose.yml logs --tail=100
```

At this point the app should answer on `http://APP_VM_PUBLIC_IP:8080`, but do not rely on that as the public entry point. TLS still needs to be added.

## 8. Put HTTPS In Front Of The App

Create an Nginx site on the host VM that proxies HTTPS traffic to the web container on `127.0.0.1:8080`.

Write the config:

```sh
cat > /etc/nginx/sites-available/localchat <<'EOF'
server {
  listen 80;
  server_name app.example.com;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
EOF
```

Enable the site and reload Nginx:

```sh
ln -sf /etc/nginx/sites-available/localchat /etc/nginx/sites-enabled/localchat
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

Request the TLS certificate:

```sh
certbot --nginx -d app.example.com
```

After this finishes, browse to `https://app.example.com` and confirm the page loads over HTTPS.

## 9. Initial Setup On The TURN VM

SSH into the TURN VM:

```sh
ssh root@turn.example.com
```

Install coturn:

```sh
apt update && apt upgrade -y
apt install -y coturn
```

Enable the service:

```sh
sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

Create `/etc/turnserver.conf`:

```sh
cat > /etc/turnserver.conf <<'EOF'
listening-port=3478
fingerprint
lt-cred-mech
realm=turn.example.com
user=localchat:CHANGE_TURN_PASSWORD
external-ip=TURN_VM_PUBLIC_IP
min-port=49160
max-port=49200
no-cli
no-multicast-peers
stale-nonce
EOF
```

Replace:

- `CHANGE_TURN_PASSWORD` with a strong password
- `TURN_VM_PUBLIC_IP` with the TURN VM's public IP

Start coturn:

```sh
systemctl enable --now coturn
systemctl status coturn --no-pager
```

If you use `ufw`, open the TURN ports:

```sh
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49160:49200/udp
```

## 10. Advertise TURN From The App VM

Return to the app VM and update the env file so the server sends both STUN and TURN ICE servers to browsers.

Edit `/opt/LocalChat/infra/.env.production` so it contains:

```sh
NODE_ENV=production
PORT=3000
CLIENT_ORIGIN=https://app.example.com
DATABASE_URL=postgres://localchat:CHANGE_DB_PASSWORD@postgres:5432/localchat
REDIS_URL=redis://redis:6379
STUN_SERVER_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_SERVER_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_USERNAME=localchat
TURN_PASSWORD=CHANGE_TURN_PASSWORD
```

Restart the app stack:

```sh
cd /opt/LocalChat
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml up -d --build
```

This app does not force TURN. Browsers will still prefer direct peer-to-peer routes and only relay through TURN when direct connectivity fails.

## 11. Verify The Deployment

Run these checks from the app VM:

```sh
curl -i http://127.0.0.1:3000/api/health
curl -I http://127.0.0.1:8080
curl -I https://app.example.com
```

Check the running containers:

```sh
cd /opt/LocalChat
podman ps
podman-compose -f infra/podman-compose.yml logs -f server web
```

Check coturn on the TURN VM:

```sh
systemctl status coturn --no-pager
journalctl -u coturn -n 100 --no-pager
```

Then do a real browser test:

1. Open the app on two different devices.
2. Match the two users.
3. Confirm camera and microphone permissions work.
4. Confirm the call connects.
5. If possible, test one device from a different network such as mobile data.

If direct peer-to-peer fails on a restrictive network but the call still connects, TURN fallback is working.

## 12. Basic Operations

To deploy a new version on the app VM:

```sh
cd /opt/LocalChat
git pull
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml up -d --build
```

To restart the app stack:

```sh
cd /opt/LocalChat
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml restart
```

To stop the app stack:

```sh
cd /opt/LocalChat
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml down
```

## 13. Recommended Next Improvements

After the first deployment is stable, the next upgrades should be:

1. Move Postgres to a managed service or separate VM if persistence becomes critical.
2. Replace static TURN credentials with time-limited TURN credentials.
3. Add monitoring for app health, ICE failures, and TURN relay usage.
4. Expand the TURN UDP relay port range if concurrent relayed calls increase.
5. Back up the Postgres volume regularly.

## 14. Common Mistakes

If the site loads but video fails, these are the first things to check:

- `CLIENT_ORIGIN` is not set to the exact HTTPS app origin.
- the app domain is not using HTTPS.
- `TURN_SERVER_URLS` points at an internal hostname instead of `turn.example.com`.
- the TURN firewall is open on `3478` but not on the relay UDP range.
- `external-ip` in `/etc/turnserver.conf` does not match the TURN VM public IP.
- DNS for `app.example.com` or `turn.example.com` still points to the wrong server.

If you want the cheapest acceptable public deployment, stop here. This is enough for a real first beta on Hetzner without introducing AWS complexity.