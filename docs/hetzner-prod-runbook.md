# Hetzner Production Runbook

This runbook is the practical checklist for rebuilding the current SightHop production VM from scratch and for recovering service after a VM restart.

It assumes the current production shape:

- one Hetzner Cloud VM
- host Nginx on the VM
- `coturn` on the same VM
- Podman base stack for Postgres and Redis
- Podman blue/green release stacks for `server` and `web`
- app served at `https://sighthop.app`
- TURN served at `turn.sighthop.app`

If you later move TURN or the app to a second VM, use this as the starting point and adapt the hostnames and firewall rules.

## 1. What You Need Before You Start

Have these ready before you provision the VM:

- a Hetzner Cloud project
- an Ubuntu 24.04 VM with a public IPv4 address
- your SSH key added to Hetzner
- the `sighthop.app` domain in Cloudflare
- these DNS records, all set to `DNS only`
  - `A @ -> YOUR_VM_IP`
  - `A app -> YOUR_VM_IP`
  - `A turn -> YOUR_VM_IP`
- a Hetzner firewall attached to the VM with inbound rules for:
  - `22/tcp`
  - `80/tcp`
  - `443/tcp`
  - `3478/tcp`
  - `3478/udp`
  - `49160-49200/udp`

Do not open `5432` or `6379` in the firewall.

## 2. Build A New Production VM From Scratch

### 2.1 Install Base Packages

SSH into the VM as `root` and install the host dependencies:

```sh
apt update && apt upgrade -y
apt install -y git podman podman-compose nginx certbot python3-certbot-nginx coturn openssl
systemctl enable --now nginx
sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

### 2.2 Clone The Repository

```sh
cd /opt
git clone https://github.com/YOUR_GITHUB_USERNAME/SightHop.git
cd /opt/SightHop
chmod +x infra/bin/*.sh
```

### 2.3 Create Production Secrets

Generate strong values directly on the VM:

```sh
openssl rand -hex 24
openssl rand -hex 24
openssl rand -hex 32
```

Use them for:

- `POSTGRES_PASSWORD`
- `TURN_PASSWORD`
- `DEPLOY_ADMIN_TOKEN`

### 2.4 Create The Production Env File

Create `/opt/SightHop/infra/.env.production`:

```sh
cat > /opt/SightHop/infra/.env.production <<'EOF'
CLIENT_ORIGIN=https://sighthop.app
CLIENT_ORIGINS=https://sighthop.app,https://app.sighthop.app
POSTGRES_USER=sighthop
POSTGRES_PASSWORD=CHANGE_DB_PASSWORD
POSTGRES_DB=sighthop
STUN_SERVER_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_SERVER_URLS=turn:turn.sighthop.app:3478?transport=udp,turn:turn.sighthop.app:3478?transport=tcp
TURN_USERNAME=sighthop
TURN_PASSWORD=CHANGE_TURN_PASSWORD
DEPLOY_ADMIN_TOKEN=CHANGE_DEPLOY_ADMIN_TOKEN
EOF
```

Replace the `CHANGE_*` values with the real generated secrets.

### 2.5 Configure Host Nginx

Install the blue/green host config:

```sh
cp /opt/SightHop/infra/nginx/sighthop-blue-green.conf /etc/nginx/conf.d/sighthop.conf
cp /opt/SightHop/infra/nginx/sighthop-active-release.conf /etc/nginx/conf.d/sighthop-active-release.conf
sed -i 's/app\.example\.com/sighthop.app app.sighthop.app/g' /etc/nginx/conf.d/sighthop.conf
nginx -t
systemctl reload nginx
```

### 2.6 Issue The TLS Certificate

Request a certificate for both the primary domain and the transition alias:

```sh
certbot --nginx -d sighthop.app -d app.sighthop.app
```

Use a real email address when Certbot prompts. If it asks whether to expand or replace an existing certificate, choose the option that includes both names.

### 2.7 Configure coturn

Write `/etc/turnserver.conf`:

```sh
cat > /etc/turnserver.conf <<'EOF'
listening-port=3478
fingerprint
lt-cred-mech
realm=turn.sighthop.app
user=sighthop:CHANGE_TURN_PASSWORD
external-ip=YOUR_VM_IP
min-port=49160
max-port=49200
no-cli
no-multicast-peers
stale-nonce
no-tls
no-dtls
EOF
```

Replace:

- `CHANGE_TURN_PASSWORD` with the same value used in `.env.production`
- `YOUR_VM_IP` with the VM public IP

Then start `coturn`:

```sh
systemctl enable --now coturn
systemctl status coturn --no-pager
```

### 2.8 Start The Base Stack

Start shared Postgres and Redis:

```sh
cd /opt/SightHop
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/start-base-stack.sh
podman ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

You want both base services healthy:

- `sighthop-base_postgres_1`
- `sighthop-base_redis_1`

### 2.9 Deploy The First Release

Deploy `blue` first:

```sh
cd /opt/SightHop
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/deploy-release.sh blue
```

This builds the `blue` `server` and `web` containers, waits for the server health check, and then points Nginx at `blue` for new traffic.

### 2.10 Verify The Production VM

Run these checks:

```sh
curl -i http://127.0.0.1:13000/api/health
curl -I http://127.0.0.1:18080
curl -I https://sighthop.app
ss -luntp | grep 3478
systemctl status coturn --no-pager
```

You want to see:

- `/api/health` returns `200` with Postgres and Redis both `true`
- `https://sighthop.app` returns `200`
- `coturn` listens on `3478/tcp` and `3478/udp`
- `coturn` is `active (running)`

Then do a real browser test with two devices, ideally on different networks.

## 3. How To Deploy A New Version Later

From the VM:

```sh
cd /opt/SightHop
git pull
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/deploy-release.sh green --drain-old
```

The next deployment swaps back to `blue`.

## 4. How To Recover After A VM Restart

This is the important operational fact for the current setup:

- `nginx` and `coturn` come back automatically because they are systemd services
- the Podman base stack and active release do not currently auto-start on boot

That means a VM restart is recoverable, but not hands-off.

### 4.1 SSH Back In And Check Host Services

```sh
ssh root@YOUR_VM_IP
systemctl status nginx --no-pager
systemctl status coturn --no-pager
```

If either is not running:

```sh
systemctl restart nginx
systemctl restart coturn
```

### 4.2 Start The Base Stack Again

```sh
cd /opt/SightHop
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/start-base-stack.sh
```

### 4.3 Determine Which Release Was Active Before The Restart

Check the Nginx active release include:

```sh
cat /etc/nginx/conf.d/sighthop-active-release.conf
```

If it says `blue`, bring `blue` back. If it says `green`, bring `green` back.

### 4.4 Start The Previously Active Release

For `blue`:

```sh
cd /opt/SightHop
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/deploy-release.sh blue
```

For `green`:

```sh
cd /opt/SightHop
ENV_FILE=/opt/SightHop/infra/.env.production infra/bin/deploy-release.sh green
```

### 4.5 Verify Recovery

For `blue`:

```sh
curl -i http://127.0.0.1:13000/api/health
curl -I https://sighthop.app
podman ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

For `green`, use `23000` instead of `13000`.

You want:

- the active release server container `Up`
- the active release web container `Up`
- `/api/health` returning `200`
- `https://sighthop.app` returning `200`

## 5. What To Check If Recovery Fails

These are the fastest targeted checks:

```sh
podman ps -a --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
podman logs sighthop-base_postgres_1 --tail 100
podman logs sighthop-base_redis_1 --tail 100
podman logs sighthop-blue_server_1 --tail 100
podman logs sighthop-green_server_1 --tail 100
journalctl -u nginx -n 50 --no-pager
journalctl -u coturn -n 50 --no-pager
```

Common failure patterns:

- Nginx config error: run `nginx -t` and fix the invalid include or hostname
- server container exits quickly: inspect the server logs for Postgres or Redis connection failures
- `coturn` starts but relay does not work: verify `user=` and `TURN_PASSWORD` still match exactly
- root domain does not load: confirm the Cloudflare `@` A record still points to the VM IP and is `DNS only`

## 6. Known Limitation

This runbook restores service after a reboot, but it is still a manual recovery. The current deployment does not yet install boot-time systemd units for the Podman stacks.

If you want true reboot persistence, the next improvement is to add systemd units for:

- the base Podman stack
- the currently active release stack