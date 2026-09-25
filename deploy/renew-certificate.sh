#!/usr/bin/env sh
set -eu
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/games.dkz12345.com)
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
    ;;
esac
