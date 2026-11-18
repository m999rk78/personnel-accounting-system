#!/usr/bin/env bash
# Install only. Enable the timer after a successful real backup/restore check.
set -euo pipefail
umask 077

fail() { printf '%s\n' "Backup installation stopped: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail "Run as root on personnel-accounting-app."
[[ $# -eq 2 && $1 == /* && $2 == /* ]] || fail "Usage: bash ops/backup/install.sh /absolute/path/to/backup.env /absolute/path/to/notify.env"
for executable in python3 docker aws systemctl systemd-analyze install cmp realpath; do
  command -v "$executable" >/dev/null || fail "Missing dependency: $executable"
done

bundle=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source_script="$bundle/../../scripts/backup-personnel-s3.py"
notification_script="$bundle/../../scripts/personnel-backup-notify.py"
configuration=$1
notification_configuration=$2
[[ -f $source_script && ! -L $source_script ]] || fail "The runner is missing from the source bundle."
[[ -f $notification_script && ! -L $notification_script ]] || fail "The notification script is missing from the source bundle."
[[ -f $configuration && ! -L $configuration ]] || fail "The private configuration must be a regular file."
[[ -f $notification_configuration && ! -L $notification_configuration ]] || fail "The notification configuration must be a regular file."
python3 "$source_script" --config "$configuration" --check-config
python3 "$notification_script" --config "$notification_configuration" --check-config
[[ -d /data/coolify/applications/qmwx1es9ldj6oz0pdrtsgkk6 ]] || fail "This is not the expected Personnel Accounting application host."
systemctl is-active --quiet docker.service || fail "Docker is not running."
service_state=$(systemctl show --property=ActiveState --value personnel-s3-backup.service 2>/dev/null || true)
case "$service_state" in
  active|activating|reloading|deactivating)
    fail "A backup is running; leave it to finish before installing." ;;
esac

# Do not replace an existing setup or follow symlinks into unrelated directories.
for directory in /opt/personnel-s3-backup /etc/personnel-s3-backup /var/lib/personnel-s3-backup /var/lib/personnel-s3-backup-notify; do
  [[ ! -L $directory && $(realpath -m "$directory") == "$directory" ]] || fail "Unsafe installation directory."
  [[ ! -e $directory || -d $directory ]] || fail "Installation path is not a directory."
done
check_destination() {
  local source=$1 destination=$2
  [[ ! -L $destination ]] || fail "An installation target is a symlink."
  if [[ -e $destination ]]; then
    [[ -f $destination ]] || fail "An installation target is not a regular file."
    cmp -s "$source" "$destination" || fail "An existing configuration differs; it has been left unchanged: $destination"
  fi
}
check_destination "$source_script" /opt/personnel-s3-backup/backup-personnel-s3.py
check_destination "$notification_script" /opt/personnel-s3-backup/personnel-backup-notify.py
check_destination "$configuration" /etc/personnel-s3-backup/backup.env
check_destination "$notification_configuration" /etc/personnel-s3-backup/notify.env
units=(personnel-s3-backup.service personnel-s3-backup.timer personnel-s3-backup-notify.service personnel-s3-backup-notify.timer)
for unit in "${units[@]}"; do
  [[ -f $bundle/$unit && ! -L $bundle/$unit ]] || fail "Missing systemd unit."
  check_destination "$bundle/$unit" "/etc/systemd/system/$unit"
done
install -d -m 700 -o root -g root /opt/personnel-s3-backup /etc/personnel-s3-backup /var/lib/personnel-s3-backup /var/lib/personnel-s3-backup-notify
install -m 600 -o root -g root "$source_script" /opt/personnel-s3-backup/backup-personnel-s3.py
install -m 600 -o root -g root "$notification_script" /opt/personnel-s3-backup/personnel-backup-notify.py
if [[ $(realpath "$configuration") != /etc/personnel-s3-backup/backup.env ]]; then
  install -m 600 -o root -g root "$configuration" /etc/personnel-s3-backup/backup.env
fi
if [[ $(realpath "$notification_configuration") != /etc/personnel-s3-backup/notify.env ]]; then
  install -m 600 -o root -g root "$notification_configuration" /etc/personnel-s3-backup/notify.env
fi
for unit in "${units[@]}"; do
  install -m 644 -o root -g root "$bundle/$unit" "/etc/systemd/system/$unit"
done
systemd-analyze verify "${units[@]/#//etc/systemd/system/}"
systemctl daemon-reload
printf '%s\n' \
  'Backup files installed. No backup or timer was started by this installer.' \
  'Run: systemctl start personnel-s3-backup.service' \
  'Check its exit status, journal, and verified manifest before enabling the timer.' \
  'Test email: python3 /opt/personnel-s3-backup/personnel-backup-notify.py --config /etc/personnel-s3-backup/notify.env --test' \
  'Then run: systemctl enable --now personnel-s3-backup.timer personnel-s3-backup-notify.timer'
