#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <blue|green> [--drain-old]" >&2
  exit 1
fi

release="$1"
drain_old="false"
if [[ $# -eq 2 ]]; then
  if [[ "$2" != "--drain-old" ]]; then
    echo "unknown flag: $2" >&2
    exit 1
  fi
  drain_old="true"
fi

if [[ "$release" != "blue" && "$release" != "green" ]]; then
  echo "release must be blue or green" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${ENV_FILE:-$repo_root/infra/.env.production}"
compose_file="$repo_root/infra/podman-compose.release.yml"
active_release_file="${NGINX_ACTIVE_RELEASE_FILE:-/etc/nginx/conf.d/sighthop-active-release.conf}"
health_timeout_seconds="${HEALTH_TIMEOUT_SECONDS:-120}"
drain_timeout_seconds="${DRAIN_TIMEOUT_SECONDS:-1800}"

if [[ ! -f "$env_file" ]]; then
  echo "missing env file: $env_file" >&2
  exit 1
fi

set -a
. "$env_file"
set +a

export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER:-sighthop}:${POSTGRES_PASSWORD:-sighthop}@host.containers.internal:${POSTGRES_HOST_PORT:-5432}/${POSTGRES_DB:-sighthop}}"
export REDIS_URL="${REDIS_URL:-redis://host.containers.internal:${REDIS_HOST_PORT:-6379}}"

if [[ "$release" == "blue" ]]; then
  export RELEASE_NAME="blue"
  export SERVER_HOST_PORT="${BLUE_SERVER_HOST_PORT:-13000}"
  export WEB_HOST_PORT="${BLUE_WEB_HOST_PORT:-18080}"
  old_release="green"
  old_server_port="${GREEN_SERVER_HOST_PORT:-23000}"
else
  export RELEASE_NAME="green"
  export SERVER_HOST_PORT="${GREEN_SERVER_HOST_PORT:-23000}"
  export WEB_HOST_PORT="${GREEN_WEB_HOST_PORT:-28080}"
  old_release="blue"
  old_server_port="${BLUE_SERVER_HOST_PORT:-13000}"
fi

export CLIENT_ORIGIN

echo "Starting release $release on web:$WEB_HOST_PORT server:$SERVER_HOST_PORT"
podman-compose -p "sighthop-$release" -f "$compose_file" up -d --build

server_base_url="http://127.0.0.1:$SERVER_HOST_PORT"
health_url="$server_base_url/api/health"
deadline=$((SECONDS + health_timeout_seconds))
until curl --silent --fail "$health_url" >/dev/null; do
  if (( SECONDS >= deadline )); then
    echo "release $release did not become healthy in time" >&2
    exit 1
  fi
  sleep 2
done

mkdir -p "$(dirname "$active_release_file")"
printf 'map "" $sighthop_default_release {\n  default %s;\n}\n' "$release" > "$active_release_file"
nginx -t
systemctl reload nginx
echo "Activated release $release"

if [[ "$drain_old" != "true" ]]; then
  exit 0
fi

if [[ -z "${DEPLOY_ADMIN_TOKEN:-}" ]]; then
  echo "DEPLOY_ADMIN_TOKEN is required to drain the old release" >&2
  exit 1
fi

old_server_base_url="http://127.0.0.1:$old_server_port"
old_health_url="$old_server_base_url/api/health"
if ! curl --silent --fail "$old_health_url" >/dev/null; then
  echo "Old release $old_release is not running; nothing to drain"
  exit 0
fi

echo "Starting drain on old release $old_release"
curl --silent --show-error --fail \
  -X POST \
  -H "x-deploy-token: $DEPLOY_ADMIN_TOKEN" \
  "$old_server_base_url/api/admin/drain/start" >/dev/null

deadline=$((SECONDS + drain_timeout_seconds))
while true; do
  health_json="$(curl --silent --fail "$old_health_url")"
  queue_size="$(printf '%s' "$health_json" | node -e 'let body="";process.stdin.on("data",(c)=>body+=c).on("end",()=>{const json=JSON.parse(body);process.stdout.write(String(json.deployment?.queueSize ?? ""));});')"
  encounter_count="$(printf '%s' "$health_json" | node -e 'let body="";process.stdin.on("data",(c)=>body+=c).on("end",()=>{const json=JSON.parse(body);process.stdout.write(String(json.deployment?.activeEncounterCount ?? ""));});')"
  if [[ "$queue_size" == "0" && "$encounter_count" == "0" ]]; then
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "Drain timeout reached for release $old_release" >&2
    exit 1
  fi
  sleep 5
done

podman-compose -p "sighthop-$old_release" -f "$compose_file" down
echo "Stopped old release $old_release"