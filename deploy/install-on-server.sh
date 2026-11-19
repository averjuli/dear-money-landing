#!/usr/bin/env bash
# One-time setup, run by the server administrator through sudo.
# Configure only landing access. Existing SSH keys and nginx sites stay in place.
set -euo pipefail

DEPLOY_USER=dear-money-landing
DEPLOY_HOME=/home/dear-money-landing
WEB_ROOT=/var/www/dearmoney.space
MARKER=$DEPLOY_HOME/.landing-deployment-managed
MARKER_VALUE=averjuli/dear-money-landing
STUB_SHA=fa473befcbaf8bca861cf5acef767a13fc83975054adbd2ac447a12b9b65a8cf
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PUBLIC_KEY=$HERE/deploy_key.pub

fail() { printf '%s\n' "$*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || fail 'Run this script through sudo.'
command -v /usr/bin/rrsync >/dev/null || fail 'The existing rsync package must provide /usr/bin/rrsync.'
[[ -s $PUBLIC_KEY ]] || fail 'The deployment public key is missing.'
ssh-keygen -l -f "$PUBLIC_KEY" >/dev/null || fail 'The deployment public key is invalid.'
[[ -d $WEB_ROOT && ! -L $WEB_ROOT && $(readlink -f "$WEB_ROOT") == "$WEB_ROOT" ]] \
  || fail 'The expected landing directory is missing or is a symlink.'
grep -Eq '^[[:space:]]*root[[:space:]]+/var/www/dearmoney[.]space;' \
  /etc/nginx/sites-available/dearmoney-https.conf \
  || fail 'The existing nginx site does not point at the expected landing directory.'

if getent passwd "$DEPLOY_USER" >/dev/null; then
  [[ -f $MARKER && $(cat "$MARKER") == "$MARKER_VALUE" ]] \
    || fail 'The deployment account already exists and is not managed by this setup.'
  [[ $(getent passwd "$DEPLOY_USER" | cut -d: -f6) == "$DEPLOY_HOME" ]] \
    || fail 'The deployment account uses an unexpected home directory.'
else
  [[ ! -e $DEPLOY_HOME ]] || fail 'The proposed deployment home already exists.'
  [[ $(stat -c '%u:%g' "$WEB_ROOT") == 0:0 ]] || fail 'The landing directory has an unexpected owner.'
  [[ -f $WEB_ROOT/index.html && ! -L $WEB_ROOT/index.html ]] || fail 'The expected landing placeholder is missing.'
  [[ $(sha256sum "$WEB_ROOT/index.html" | cut -d' ' -f1) == "$STUB_SHA" ]] \
    || fail 'The landing directory contains a different page; nothing was changed.'
  [[ -z $(find "$WEB_ROOT" -mindepth 1 -maxdepth 1 ! -name index.html -print -quit) ]] \
    || fail 'The landing directory contains unexpected files; nothing was changed.'
  useradd --create-home --user-group --home-dir "$DEPLOY_HOME" --shell /bin/sh "$DEPLOY_USER"
  printf '%s\n' "$MARKER_VALUE" > "$MARKER"
  chown root:root "$MARKER"
  chmod 600 "$MARKER"
fi

install -d -o root -g root -m 700 "$DEPLOY_HOME/.ssh"
AUTHORIZED_KEYS=$DEPLOY_HOME/.ssh/authorized_keys
touch "$AUTHORIZED_KEYS"
chown root:root "$AUTHORIZED_KEYS"
chmod 600 "$AUTHORIZED_KEYS"
key_line="restrict,command=\"/usr/bin/rrsync -wo $WEB_ROOT\" $(cat "$PUBLIC_KEY")"
if ! grep -Fqx -- "$key_line" "$AUTHORIZED_KEYS"; then
  printf '%s\n' "$key_line" >> "$AUTHORIZED_KEYS"
fi

# Ownership of the landing directory allows replacing its placeholder.
# No recursive ownership changes and no nginx edits or reloads are needed.
chown "$DEPLOY_USER:$DEPLOY_USER" "$WEB_ROOT"
chmod 755 "$WEB_ROOT"
printf '%s\n' 'Landing deployment access is ready.'
printf 'Account: %s\nDirectory: %s\n' "$DEPLOY_USER" "$WEB_ROOT"
printf '%s\n' 'The deployment key can only upload files to the landing directory.'
