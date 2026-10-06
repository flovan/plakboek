#!/usr/bin/env bash
# Starts sshd for the throwaway deploy target.
#
# Environment: AUTHORIZED_KEY, the one public key allowed to log in as `deploy`.
# The mounted /var/run/docker.sock must be present; the deploy user is given
# the socket's group so it can run docker without being root.
set -euo pipefail

: "${AUTHORIZED_KEY:?AUTHORIZED_KEY is required}"

socket=/var/run/docker.sock
[ -S "$socket" ] || { echo "FATAL: $socket is not mounted" >&2; exit 1; }

socket_gid="$(stat -c %g "$socket")"
group_name="$(getent group "$socket_gid" | cut -d: -f1 || true)"
if [ -z "$group_name" ]; then
  group_name=dockersock
  groupadd --gid "$socket_gid" "$group_name"
fi

useradd --create-home --shell /bin/bash --groups "$group_name" deploy
# A locked password and `PasswordAuthentication no` below: key login only.
passwd --lock deploy > /dev/null

install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
printf '%s\n' "$AUTHORIZED_KEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

ssh-keygen -A

exec /usr/sbin/sshd -D -e \
  -o PasswordAuthentication=no \
  -o KbdInteractiveAuthentication=no \
  -o PermitRootLogin=no \
  -o PubkeyAuthentication=yes \
  -o AuthorizedKeysFile=.ssh/authorized_keys \
  -o AllowUsers=deploy
