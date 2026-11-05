#!/usr/bin/env bash
# Fixed-scope host setup; upload the two public scripts into bundle/scripts first.
# Does not change the running application, its environment, the database or proxy.
set -euo pipefail
umask 077

fail() { printf '%s\n' "Maintenance setup stopped: $*" >&2; exit 1; }
[[ $# -eq 0 ]] || fail "This installer takes no arguments."
[[ $EUID -eq 0 ]] || fail "Run in the selected server's root terminal."
for executable in docker flock mktemp readlink sha256sum cat cmp install chmod chown stat; do
  command -v "$executable" >/dev/null || fail "Required command is unavailable: $executable"
done

application_uuid=qmwx1es9ldj6oz0pdrtsgkk6
application_root="/data/coolify/applications/$application_uuid"
runtime="$application_root/maintenance-runtime"
bundle="$application_root/maintenance-fallback"
fallback=personnel-accounting-maintenance
network=coolify
health_command='node -e '\''fetch("http://127.0.0.1:8099/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'\'''

[[ -d $application_root && ! -L $application_root ]] || fail "The existing application's host directory was not found."
[[ $(readlink -f "$application_root") == "$application_root" ]] || fail "The application directory must not contain symlinks."
exec 9>"$application_root/.maintenance-install.lock"
flock -n 9 || fail "Another maintenance setup is running."
[[ -d $bundle && ! -L $bundle && -d $bundle/scripts && ! -L $bundle/scripts ]] || fail "Upload the dedicated fallback bundle first."
for source in maintenance-fallback.mjs maintenance-assets.mjs; do
  [[ -s $bundle/scripts/$source && ! -L $bundle/scripts/$source ]] || fail "Missing public fallback script: $source"
done
[[ ! -e $bundle/public || ( -d $bundle/public && ! -L $bundle/public ) ]] || fail "Unsafe public bundle directory."
[[ ! -e $bundle/static || ( -d $bundle/static && ! -L $bundle/static ) ]] || fail "Unsafe bundle archive mount point."
[[ ! -e $runtime || ( -d $runtime && ! -L $runtime ) ]] || fail "Unsafe runtime directory."
[[ ! -e $runtime/static || ( -d $runtime/static && ! -L $runtime/static ) ]] || fail "Unsafe public archive directory."

# The UUID prefix is intentional: refuse an in-progress rolling deployment.
mapfile -t applications < <(docker ps --filter "name=^/${application_uuid}-" --format '{{.Names}}')
[[ ${#applications[@]} -eq 1 && ${applications[0]} == "$application_uuid"-* ]] || fail "Expected exactly one running container for this application."
application=${applications[0]}
image=$(docker inspect --type container --format '{{.Image}}' "$application")
[[ $image == sha256:* ]] || fail "Could not identify the existing image."
[[ $(docker inspect --type container --format '{{if index .NetworkSettings.Networks "coolify"}}yes{{end}}' "$application") == yes ]] || fail "The application is not on the expected Coolify network."
docker exec "$application" sh -c 'test -f /app/scripts/maintenance-control.mjs && test -f /app/scripts/maintenance-gateway.mjs && test -f /app/public/maintenance.html && test -d /app/.runtime/static' || fail "The current image lacks the maintenance gateway or public archive."

stage=$(mktemp -d "$application_root/.maintenance-install.XXXXXXXX")
cleanup() { [[ -n ${stage:-} && $stage == "$application_root"/.maintenance-install.* ]] && rm -rf -- "$stage"; }
trap cleanup EXIT
install -d -m 700 "$stage/public" "$stage/static"
docker cp "$application:/app/public/maintenance.html" "$stage/public/maintenance.html" >/dev/null
docker cp "$application:/app/.runtime/static/." "$stage/static/" >/dev/null
[[ -s $stage/public/maintenance.html && ! -L $stage/public/maintenance.html ]] || fail "The current maintenance page is not a regular file."
fingerprint=$(cat "$bundle/scripts/maintenance-fallback.mjs" "$bundle/scripts/maintenance-assets.mjs" "$stage/public/maintenance.html" | sha256sum)
fingerprint=${fingerprint%% *}

existing=false
if docker inspect --type container "$fallback" >/dev/null 2>&1; then
  existing=true
  inspect() { docker inspect --type container --format "$1" "$fallback"; }
  [[ $(inspect '{{index .Config.Labels "personnel.maintenance.application"}}') == "$application_uuid" &&
     $(inspect '{{index .Config.Labels "personnel.maintenance.bundle-sha256"}}') == "$fingerprint" &&
     $(inspect '{{.Image}}') == "$image" &&
     $(inspect '{{.State.Running}}') == true &&
     $(inspect '{{.Config.User}}') == 1001:1001 &&
     $(inspect '{{.Config.WorkingDir}}') == /opt/maintenance &&
     $(inspect '{{json .Config.Entrypoint}}') == '["node"]' &&
     $(inspect '{{json .Config.Cmd}}') == '["scripts/maintenance-fallback.mjs"]' &&
     $(inspect '{{index .Config.Labels "traefik.enable"}}') == false &&
     $(inspect '{{.HostConfig.ReadonlyRootfs}}') == true &&
     $(inspect '{{.HostConfig.Privileged}}') == false &&
     $(inspect '{{.HostConfig.Init}}') == true &&
     $(inspect '{{.HostConfig.RestartPolicy.Name}}') == unless-stopped &&
     $(inspect '{{len .HostConfig.PortBindings}}') == 0 &&
     $(inspect '{{len .NetworkSettings.Networks}}') == 1 &&
     $(inspect '{{.HostConfig.NetworkMode}}') == "$network" &&
     $(inspect '{{.HostConfig.Memory}}') == 134217728 &&
     $(inspect '{{.HostConfig.NanoCpus}}') == 250000000 &&
     $(inspect '{{json .HostConfig.CapDrop}}') == '["ALL"]' &&
     $(inspect '{{json .HostConfig.SecurityOpt}}') == '["no-new-privileges"]' &&
     $(inspect '{{range .Mounts}}{{if eq .Destination "/opt/maintenance"}}{{.Source}}:{{.RW}}{{end}}{{end}}') == "$bundle:false" &&
     $(inspect '{{range .Mounts}}{{if eq .Destination "/opt/maintenance/static"}}{{.Source}}:{{.RW}}{{end}}{{end}}') == "$runtime/static:false" &&
     $(inspect '{{index .Config.Healthcheck.Test 1}}') == "$health_command" ]] || fail "An existing fallback differs from this setup; it was left untouched."
  [[ -f $bundle/public/maintenance.html && ! -L $bundle/public/maintenance.html ]] || fail "The existing fallback page is missing."
  cmp -s "$stage/public/maintenance.html" "$bundle/public/maintenance.html" || fail "The existing fallback page differs; it was left untouched."
fi

# Seed only an unused directory (including the empty one created by Coolify).
# A saved future mount does not alter the current running container.
seed_runtime=false
if [[ ! -e $runtime ]]; then
  seed_runtime=true
else
  shopt -s dotglob nullglob
  runtime_entries=("$runtime"/*)
  shopt -u dotglob nullglob
  if [[ ${#runtime_entries[@]} -eq 0 ]]; then
    [[ -z $(docker inspect --type container --format '{{range .Mounts}}{{if eq .Destination "/app/.runtime"}}{{.Source}}{{end}}{{end}}' "$application") ]] || fail "An empty runtime is already mounted by the running application."
    seed_runtime=true
  fi
fi
if [[ $seed_runtime == true ]]; then
  install -d -m 700 -o 1001 -g 1001 "$runtime"
  printf '%s\n' '{"maintenance":true,"revision":"initial-existing-image-install"}' >"$runtime/maintenance.json"
  chown 1001:1001 "$runtime/maintenance.json"
  chmod 600 "$runtime/maintenance.json"
else
  [[ -f $runtime/maintenance.json && ! -L $runtime/maintenance.json ]] || fail "An existing runtime has no safe state file; refusing to seed it."
fi
[[ $(stat -c '%u:%g' "$runtime") == 1001:1001 ]] || fail "The existing runtime must belong to 1001:1001."
install -d -m 700 -o 1001 -g 1001 "$runtime/static"
if [[ $existing == false ]]; then
  # Docker cannot create a nested mount point inside a read-only parent bind.
  install -d -m 700 -o 1001 -g 1001 "$bundle/public" "$bundle/static"
  install -m 600 -o 1001 -g 1001 "$stage/public/maintenance.html" "$bundle/public/maintenance.html"
  chown 1001:1001 "$bundle" "$bundle/scripts" "$bundle/scripts/maintenance-fallback.mjs" "$bundle/scripts/maintenance-assets.mjs"
  chmod 700 "$bundle" "$bundle/scripts"
  chmod 600 "$bundle/scripts/maintenance-fallback.mjs" "$bundle/scripts/maintenance-assets.mjs"
fi
chown -Rh 1001:1001 "$stage"

# This container runs only the public-asset helper, never the image's app command.
docker run --rm --pull=never --network none --user 1001:1001 --read-only \
  --cap-drop ALL --security-opt no-new-privileges --memory 128m --cpus 0.25 \
  --mount "type=bind,source=$bundle,target=/opt/maintenance,readonly" \
  --mount "type=bind,source=$stage/static,target=/incoming,readonly" \
  --mount "type=bind,source=$runtime,target=/runtime" \
  --entrypoint node "$image" --input-type=module -e \
  'import {readFileSync} from "node:fs"; import {archiveMaintenanceAssets} from "/opt/maintenance/scripts/maintenance-assets.mjs"; const state=JSON.parse(readFileSync("/runtime/maintenance.json","utf8")); if(typeof state.maintenance!=="boolean"||typeof state.revision!=="string")throw Error("Invalid existing maintenance state"); archiveMaintenanceAssets({sourceRoot:"/incoming",archiveRoot:"/runtime/static"});' >/dev/null

if [[ $existing == false ]]; then
  docker run -d --pull=never --name "$fallback" --restart unless-stopped --init \
    --user 1001:1001 --read-only --cap-drop ALL --security-opt no-new-privileges \
    --memory 128m --cpus 0.25 --tmpfs /tmp:size=8m,mode=1777 \
    --network "$network" --network-alias personnel-maintenance \
    --label traefik.enable=false \
    --label "personnel.maintenance.application=$application_uuid" \
    --label "personnel.maintenance.bundle-sha256=$fingerprint" \
    --mount "type=bind,source=$bundle,target=/opt/maintenance,readonly" \
    --mount "type=bind,source=$runtime/static,target=/opt/maintenance/static,readonly" \
    --env HOST=0.0.0.0 --env PORT=8099 --env MAINTENANCE_STATIC_ARCHIVE=/opt/maintenance/static \
    --workdir /opt/maintenance --entrypoint node \
    --health-cmd "$health_command" --health-interval 30s --health-timeout 3s \
    --health-start-period 5s --health-retries 3 \
    "$image" scripts/maintenance-fallback.mjs >/dev/null
fi
docker exec "$fallback" node --input-type=module -e \
  'let ready=false; for(let n=0;n<20;n++){try{const health=await fetch("http://127.0.0.1:8099/health"); ready=health.ok; await health.body?.cancel(); if(ready)break;}catch{} await new Promise(r=>setTimeout(r,250));} if(!ready)throw Error("Fallback health check failed"); const page=await fetch("http://127.0.0.1:8099/"); if(page.status!==503)throw Error("Fallback response check failed"); await page.body?.cancel();' >/dev/null
printf '%s\n' 'Maintenance fallback is ready; the running application was not changed.' 'Configure this application runtime mount, deployment hooks and domain-only proxy routing separately.'
