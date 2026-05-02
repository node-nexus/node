# Node Nexus

Node Nexus: decentralized local WebOps reports from real user-run nodes.

Each operator runs a node from their real location. A requester can dispatch a browser task to one or more geographically distributed nodes over Gensyn AXL. Each node executes the task locally with browser-use and Qwen through the 0G router, generates a human-style PDF report with screenshots and local UX observations, uploads report artifacts to 0G Storage when enabled, and returns report details over the mesh.

## Architecture

```text
Requester
  -> local Node Nexus API
  -> Gensyn AXL mesh
  -> remote Node Nexus operators
  -> /mcp/execute on each local node
  -> browser-use + Qwen
  -> PDF report + screenshots
  -> 0G Storage
  -> report URI + summary over AXL
```

## Why It Exists

Global web behavior is local. Consent banners, language, search results, CDN routing, blocked content, pricing, currency, redirects, and login walls can all differ by operator location. Node Nexus turns real user-run nodes into a decentralized local WebOps testing network.

## How It Works

- **AXL mesh:** real inter-node communication uses Gensyn AXL. Node Nexus does not replace it with centralized discovery.
- **Local execution:** each node runs browser-use with Qwen via the 0G OpenAI-compatible router.
- **Reports:** the Python agent captures evidence screenshots and renders `report.pdf`.
- **0G Storage:** real mode uploads PDF and metadata to 0G Storage; disabled mode keeps local artifacts only.

## Modes

- `AXL_MODE=disabled`: local HTTP API only.
- `AXL_MODE=mock`: starts the local setup shim and labels all mesh behavior as mock.
- `AXL_MODE=real`: starts a real AXL binary and fails clearly if missing.
- `ZERO_G_UPLOAD_MODE=disabled`: returns local report paths, no fake hash.
- `ZERO_G_UPLOAD_MODE=real`: uploads report and metadata using 0G Storage credentials.

## Setup

```bash
npm install
cp .env.example .env
cp config/node-profile.example.json config/node-profile.json
npm run setup
```

Edit `config/node-profile.json` with the real operator location. Do not hardcode fake country/city for production demos.

`npm run setup` does the full local dependency setup:

- Detects an existing real AXL binary at `AXL_BINARY_PATH` or `bin/axl-core/node`.
- If missing, clones `https://github.com/gensyn-ai/axl` into ignored `vendor/axl/` and builds the official Go node with the upstream-pinned `GOTOOLCHAIN=go1.25.5`.
- Generates `bin/axl-core/private.pem` and `bin/axl-core/node-config.json`.
- Falls back to the mock shim only if the build fails and `REQUIRE_REAL_AXL=true` is not set.
- Creates/reuses `python-agent/venv`, installs browser-use/Qwen/report dependencies, and installs Playwright Chromium.

If you change `AXL_MCP_FORWARD_URL`, `AXL_PEERS`, or `AXL_LISTEN`, rerun `npm run setup` so `bin/axl-core/node-config.json` matches the node you intend to start.

Check 0G inference credentials:

```bash
npm run check:0g
```

## Running

Local node with no mesh and no storage upload:

```bash
AXL_MODE=disabled ZERO_G_UPLOAD_MODE=disabled npm start
```

Mock AXL:

```bash
AXL_MODE=mock ZERO_G_UPLOAD_MODE=disabled npm start
```

Real AXL:

```bash
AXL_MODE=real \
AXL_BINARY_PATH=bin/axl-core/node \
AXL_CONFIG_PATH=bin/axl-core/node-config.json \
AXL_NETWORK=testnet \
AXL_IDENTITY=node-identity \
AXL_MCP_FORWARD_URL=http://localhost:8080/mcp/execute \
npm start
```

Real 0G upload:

```bash
ZERO_G_UPLOAD_MODE=real \
ZERO_G_STORAGE_RPC_URL=https://evmrpc-testnet.0g.ai \
ZERO_G_STORAGE_INDEXER_URL=https://indexer-storage-testnet-turbo.0g.ai \
ZERO_G_PRIVATE_KEY=... \
npm start
```

## API Examples

Health:

```bash
curl http://localhost:8080/health
```

Node profile:

```bash
curl http://localhost:8080/node/profile
```

AXL status:

```bash
curl http://localhost:8080/axl/status
```

Run a local WebOps task:

```bash
curl -X POST http://localhost:8080/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "demo-001",
    "url": "https://example.com",
    "task": "Open the site, observe the page from this local node, and capture evidence.",
    "reportType": "webops-local-ux"
  }'
```

Dispatch skeleton:

```bash
curl -X POST http://localhost:8080/axl/dispatch \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "task": "Check local UX and capture a report.",
    "targetNodes": ["peer-id-1", "peer-id-2"],
    "targetLocations": ["IN", "US"],
    "reportType": "webops-local-ux"
  }'
```

In real AXL mode, dispatch requires a configured real AXL local API. Node Nexus does not fake remote delivery.

## Artifact Layout

```text
artifacts/
  <taskId>/
    metadata.json
    screenshots/
      01-final.png
      step-001.png
    report.pdf
  node-metadata.json
```

`ARTIFACT_RETENTION=keep` is the default. `ARTIFACT_RETENTION=delete_screenshots_after_upload` deletes screenshots after the upload phase.

## Sponsor Alignment

- **Gensyn AXL:** inter-node mesh communication is the required real-mode path.
- **0G:** PDF reports and metadata are uploaded to 0G Storage in real upload mode.

## Known Limitations

- Qwen JSON can be unstable; the agent normalizes browser-use actions and falls back to a deterministic report summary if report analysis fails.
- YouTube and complex SPAs can be slow.
- Real mesh mode requires a real AXL binary and compatible local API for remote dispatch.
- Real 0G upload requires funded 0G credentials.

## Demo Script

1. Start Node A:
   `AXL_MODE=mock ZERO_G_UPLOAD_MODE=disabled PORT=8080 npm start`
2. Start Node B from another checkout or terminal with a different port/profile.
3. Submit `/mcp/execute` locally or call `/axl/dispatch` in mock mode.
4. Inspect `artifacts/<taskId>/report.pdf` and `metadata.json`.
5. Enable `ZERO_G_UPLOAD_MODE=real` with credentials to collect real `0g://...` report URIs.

## Compatibility Notes

The CLI file remains `bin/pookie.js` and the `pookie-node` binary alias remains available to avoid breaking existing scripts. User-facing product text and runtime service names use Node Nexus.
