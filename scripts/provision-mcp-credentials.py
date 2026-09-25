#!/usr/bin/env python3
"""Issue independent Codex/Claude Code credentials via SSH stdin, never stdout."""
import json
import os
from pathlib import Path
import secrets
import subprocess

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / "docs" / "deployment-private"
URL = "https://games.dkz12345.com/mcp"
SSH_KEY = Path.home() / "Desktop/ssh-key-removing-restricted/leo-web-key.pem"


def private_write(file, text):
    temp = file.with_suffix(file.suffix + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)
    os.chmod(temp, 0o600)
    temp.replace(file)


def main():
    if not SSH_KEY.is_file():
        raise RuntimeError("Configured SSH key is missing")
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    PRIVATE.chmod(0o700)
    result = []
    for label in ("codex", "claude-code"):
        file = PRIVATE / (label + ".token")
        if not file.exists():
            private_write(file, "ghm_" + secrets.token_urlsafe(32) + "\n")
        secret = file.read_text().strip()
        command = ("cd /opt/apps/game-hub/current && sudo -n runuser -u gamehub -g www-data -G gamehub -- "
                   "node --env-file=/etc/game-hub.env dist/scripts/mcp-admin.js create-token "
                   + label + " read,content,accounts,ops 90")
        proc = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
                               "-o", "ConnectTimeout=12", "-i", str(SSH_KEY), "leo@20.48.14.96", command],
                              input=secret + "\n", text=True, capture_output=True, timeout=45)
        if proc.returncode:
            raise RuntimeError("Credential provisioning failed for " + label + "; rerun safely after checking SSH/service")
        meta = json.loads(proc.stdout)
        private_write(PRIVATE / (label + ".metadata.json"), json.dumps(meta, indent=2) + "\n")
        private_write(PRIVATE / (label + ".env"), "export GAME_HUB_MCP_TOKEN='" + secret + "'\n")
        if label == "codex":
            fragment = ('[mcp_servers.game_hub]\nurl = "' + URL + '"\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n'
                        'http_headers = { Authorization = "Bearer ' + secret + '" }\n')
            private_write(PRIVATE / "codex-mcp.toml", fragment)
        else:
            fragment = {"mcpServers": {"game-hub": {"type": "http", "url": URL, "headers": {"Authorization": "Bearer " + secret}}}}
            private_write(PRIVATE / "claude-code.mcp.json", json.dumps(fragment, indent=2) + "\n")
        result.append(meta)
    print(json.dumps({"credentials": result, "privateDirectory": str(PRIVATE), "clientConfigurationChanged": False}, indent=2))


if __name__ == "__main__":
    main()
