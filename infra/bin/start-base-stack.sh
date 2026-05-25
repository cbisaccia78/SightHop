#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${ENV_FILE:-$repo_root/infra/.env.production}"
compose_file="$repo_root/infra/podman-compose.base.yml"

if [[ -f "$env_file" ]]; then
  set -a
  . "$env_file"
  set +a
fi

podman-compose -p sighthop-base -f "$compose_file" up -d