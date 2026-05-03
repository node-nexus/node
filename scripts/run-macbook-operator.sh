#!/usr/bin/env bash
set -euo pipefail

cd /Users/priyanshuranjan/developer/openagents

export NODE_NEXUS_PROFILE_PATH=config/node-profile.json
export NODE_NEXUS_ROLE=operator
export PORT=8081
export AXL_MODE=real
export AXL_BINARY_PATH=bin/axl-core/node
export AXL_CONFIG_PATH=bin/axl-core/node-config.json
export AXL_NETWORK=testnet
export AXL_IDENTITY=macbook-operator-001
export AXL_API_URL=http://127.0.0.1:9002
export AXL_MCP_FORWARD_URL=http://127.0.0.1:8081/mcp/execute
export AXL_PEERS=tls://161.35.61.46:9001
export AXL_LISTEN=
export AXL_FAIL_FAST=true
export ZERO_G_UPLOAD_MODE=disabled
export PATH=/Users/priyanshuranjan/.nvm/versions/node/v24.9.0/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin

exec npm start
