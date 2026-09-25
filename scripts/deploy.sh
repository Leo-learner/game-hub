#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
[ "$(node -p 'process.versions.node.split(".")[0]')" -eq 22 ] || { echo "Use Node.js 22 before deployment" >&2; exit 1; }
npm run check
[ -z "$(git status --porcelain)" ] || { echo "Commit verified source and docs before deploying" >&2; exit 1; }
commit=$(git rev-parse HEAD)
branch=$(git branch --show-current)
remote_commit=$(git ls-remote origin "refs/heads/$branch" | awk '{print $1}')
[ "$commit" = "$remote_commit" ] || { echo "Push this exact verified commit to origin first" >&2; exit 1; }
release=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p .work/deploy
archive="$root/.work/deploy/game-hub-$release.tar.gz"
tarfile="$root/.work/deploy/game-hub-$release.tar"
git archive --format=tar "$commit" > "$tarfile"
node --input-type=module - "$commit" "$release" <<'JS'
import {writeFileSync} from 'node:fs';
writeFileSync('.work/deploy/RELEASE.json', JSON.stringify({commit:process.argv[2],release:process.argv[3],repository:'https://github.com/Leo-learner/game-hub'},null,2)+'\n');
JS
tar_opts=()
if [[ "$(uname -s)" == Darwin ]]; then tar_opts+=(--no-xattrs --disable-copyfile); fi
tar "${tar_opts[@]}" -rf "$tarfile" dist public/sdk
tar "${tar_opts[@]}" -rf "$tarfile" -C .work/deploy RELEASE.json
gzip -c "$tarfile" > "$archive"
rm "$tarfile"
key="$HOME/Desktop/ssh-key-removing-restricted/leo-web-key.pem"
test -f "$key"
opts=(-o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=12 -i "$key")
scp "${opts[@]}" "$archive" "leo@20.48.14.96:/tmp/game-hub-$release.tar.gz"
ssh "${opts[@]}" leo@20.48.14.96 "sudo -n bash -s -- $release $commit" < deploy/install.sh
printf '%s\n' "$release" > .work/deploy/latest-release
