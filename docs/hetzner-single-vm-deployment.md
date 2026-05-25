# Hetzner Single-VM Starter Guide

This guide shows the cheapest reasonable public deployment for SightHop on Hetzner Cloud using one Ubuntu VM.

You will run:

- the web app, API, Socket.IO signaling, Postgres, and Redis in the repo's existing `podman-compose` stack
- `coturn` directly on the VM for TURN fallback
- Nginx on the VM to terminate HTTPS and proxy traffic to the web container

This is the right shape if you want to launch quickly and keep costs low. It is not the final shape you should keep forever. At the end of this guide there is a clean migration path to the two-VM layout.

## 1. What You Are Building

At the end of this guide you will have:

- `https://app.example.com` serving the SightHop app
- `turn.example.com` resolving to the same VM for TURN fallback
- one Hetzner VM running both the app stack and coturn

Suggested starting size:

- 2 vCPU
- 4 GB RAM
- 40 GB SSD

If you expect only a handful of testers, 2 GB RAM may work, but 4 GB is safer once Postgres, Redis, containers, and coturn are all on the same box.

## 2. When To Use This Layout

Use the single-VM layout when:

- you want the cheapest real public deployment
- you are still validating product fit
- you expect low to moderate traffic
- you want TURN fallback without paying for a second VM yet

Do not keep this layout if:

- TURN relay usage becomes a significant share of call time
- CPU, RAM, or network usage starts spiking
- you want stronger isolation between the app and relay traffic

## 3. Prerequisites

Before you begin, have these ready:

- a Hetzner Cloud account
- a domain name you control
- an SSH key added to Hetzner Cloud
- this repository pushed to GitHub or otherwise reachable from the VM

You also need two DNS names, even though they point to the same VM at first:

- `app.example.com`
- `turn.example.com`

Keeping separate hostnames now makes the later move to two VMs much easier.

## 4. Create The VM In Hetzner

In the Hetzner Cloud console:

1. Create an Ubuntu 24.04 VM.
2. Attach your SSH key.
3. Note the VM's public IPv4 address.

Name it something obvious such as `sighthop-prod-1`.

## 5. Configure DNS

Create these DNS records:

- `A app.example.com -> VM_PUBLIC_IP`
- `A turn.example.com -> VM_PUBLIC_IP`

Wait for DNS to resolve before requesting TLS certificates.

## 6. Configure Firewall Rules

Open these public ports for the VM:

- `22/tcp` for SSH
- `80/tcp` for HTTP and certificate issuance
- `443/tcp` for HTTPS
- `3478/tcp` for TURN over TCP
- `3478/udp` for TURN over UDP
- `49160-49200/udp` for relayed media

That relay UDP range is intentionally modest for an early deployment. Increase it later if concurrent relayed calls grow.

## 7. Install Base Packages

SSH into the VM:

```sh
ssh root@app.example.com
```

Install the packages you need:

```sh
apt update && apt upgrade -y
apt install -y git podman podman-compose nginx certbot python3-certbot-nginx coturn
systemctl enable --now nginx
```

Enable coturn in its default service file:

```sh
sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
```

## 8. Clone The Repository

```sh
cd /opt
git clone https://github.com/YOUR_GITHUB_USERNAME/SightHop.git
cd SightHop
```

## 9. Create The App Environment File

Create `/opt/SightHop/infra/.env.production`:

```sh
cat > /opt/SightHop/infra/.env.production <<'EOF'
NODE_ENV=production
PORT=3000
CLIENT_ORIGIN=https://app.example.com
DATABASE_URL=postgres://CHANGE_DB_USER:CHANGE_DB_PASSWORD@postgres:5432/CHANGE_DB_NAME
REDIS_URL=redis://redis:6379
STUN_SERVER_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
TURN_SERVER_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp
TURN_USERNAME=CHANGE_TURN_USERNAME
TURN_PASSWORD=CHANGE_TURN_PASSWORD
EOF
```

Replace:

- `CHANGE_DB_USER` with your database user
- `CHANGE_DB_PASSWORD` with a strong database password
- `CHANGE_DB_NAME` with your database name
- `CHANGE_TURN_USERNAME` with your TURN username
- `CHANGE_TURN_PASSWORD` with a strong TURN password

## 10. Start The App Containers

From the repo root:

```sh
cd /opt/SightHop
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml up -d --build
```

Check the containers:

```sh
podman ps
podman-compose -f infra/podman-compose.yml logs --tail=100
```

The web container should now answer on `http://127.0.0.1:8080` on the host.

## 11. Put HTTPS In Front Of The App

Create the Nginx site:

```sh
cat > /etc/nginx/sites-available/sighthop <<'EOF'
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

Enable the site:

```sh
ln -sf /etc/nginx/sites-available/sighthop /etc/nginx/sites-enabled/sighthop
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

Request the certificate:

```sh
certbot --nginx -d app.example.com
```

After this finishes, confirm `https://app.example.com` loads.

## 12. Configure coturn On The Same VM

Write `/etc/turnserver.conf`:

```sh
cat > /etc/turnserver.conf <<'EOF'
listening-port=3478
fingerprint
lt-cred-mech
realm=turn.example.com
user=sighthop:CHANGE_TURN_PASSWORD
external-ip=VM_PUBLIC_IP
min-port=49160
max-port=49200
no-cli
no-multicast-peers
stale-nonce
EOF
```

Replace:

- `CHANGE_TURN_PASSWORD` with the same TURN password you used in `.env.production`
- `VM_PUBLIC_IP` with the VM's public IP

Start coturn:

```sh
systemctl enable --now coturn
systemctl status coturn --no-pager
```

If you use `ufw`, allow the TURN ports:

```sh
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49160:49200/udp
```

## 13. Verify The Single-VM Deployment

Run these checks on the VM:

```sh
curl -i http://127.0.0.1:3000/api/health
curl -I http://127.0.0.1:8080
curl -I https://app.example.com
systemctl status coturn --no-pager
```

Check the app logs:

```sh
cd /opt/SightHop
podman-compose -f infra/podman-compose.yml logs -f server web
```

Then do a real browser test:

1. Open the app on two different devices.
2. Match the users.
3. Confirm the call connects over HTTPS.
4. Test at least one device from a different network if possible.

If restrictive-network calls still connect, TURN fallback is active.

## 14. Day-2 Operations

To deploy a new version:

```sh
cd /opt/SightHop
git pull
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml up -d --build
```

To restart the app containers:

```sh
cd /opt/SightHop
set -a
. infra/.env.production
set +a
podman-compose -f infra/podman-compose.yml restart
```

To inspect coturn logs:

```sh
journalctl -u coturn -n 100 --no-pager
```

## 15. Transition Path To The Two-VM Layout

When the single box starts feeling tight, move only TURN first. That is the cleanest upgrade path.

### Step 1: Decide When To Split

Move to two VMs when one or more of these is true:

- relayed calls are common enough that TURN traffic is competing with app traffic
- CPU or RAM on the single VM is regularly busy
- you want the app host isolated from public TURN exposure
- you need a wider TURN relay port range

### Step 2: Create The New TURN VM

Provision a second Hetzner VM with Ubuntu 24.04 in the same region.

Open these ports on the new TURN VM:

- `22/tcp`
- `3478/tcp`
- `3478/udp`
- `49160-49200/udp`

### Step 3: Install coturn On The New VM

Repeat the coturn setup from the dedicated TURN guide in [docs/hetzner-vm-deployment.md](docs/hetzner-vm-deployment.md), using the same TURN username and password if you want the app config change to stay minimal.

### Step 4: Move The TURN DNS Record

Update DNS so:

- `A turn.example.com -> NEW_TURN_VM_PUBLIC_IP`

Leave `app.example.com` pointing at the original app VM.

Because the app already advertises `turn.example.com`, this is the key compatibility move. The client config does not need to change if the hostname stays the same.

### Step 5: Update coturn External IP

On the new TURN VM, set:

```sh
external-ip=NEW_TURN_VM_PUBLIC_IP
```

Restart coturn there:

```sh
systemctl restart coturn
```

### Step 6: Remove coturn From The App VM

Once DNS has propagated and the new TURN VM is working:

```sh
systemctl disable --now coturn
```

You can keep the same app env file on the app VM because `TURN_SERVER_URLS` still points at `turn.example.com`.

### Step 7: Re-Test Calls

Run the same browser tests again. If calls connect and the TURN VM logs show activity when direct P2P fails, the split is complete.

## 16. Common Mistakes

If the site works but calls fail, check these first:

- `CLIENT_ORIGIN` does not exactly match `https://app.example.com`
- `TURN_PASSWORD` in the app env does not match `user=...` in `/etc/turnserver.conf`
- `TURN_SERVER_URLS` uses a private hostname instead of `turn.example.com`
- the TURN UDP relay range is blocked by the firewall
- `external-ip` is wrong in `turnserver.conf`
- you tested over HTTP instead of HTTPS

This single-VM layout is the cheapest good-enough starting point. The transition path above lets you move only the TURN workload to a second VM without re-architecting the app deployment.