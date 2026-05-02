# Pookie Node Network

CLI edge client for the Pookie Node Network ETHGlobal hackathon MVP.

Pookie lets a laptop join a WebOps task mesh, receive MCP-style execution requests, run an AI browser worker, and return a 0G-hosted tester report. This repo is intentionally hackathon-shaped: the P2P, payment, browser, and storage seams are all visible so judges can understand the full DePIN flow quickly.

## Quickstart for Judges

```bash
npm install
npm run setup
cp .env.example .env
npm run check:0g
npm start
```

Then edit `.env` before starting for real:

```bash
NODE_NAME=pookie-laptop-node
ENS_IDENTITY=your-node.eth
ZEROG_API_KEY=your_0g_router_api_key
ZEROG_PRIVATE_KEY=your_0g_storage_private_key
ZEROG_BASE_URL=https://router-api-testnet.integratenetwork.work/v1
ZEROG_MODEL=qwen/qwen-2.5-7b-instruct
ZEROG_STORAGE_RPC_URL=https://evmrpc-testnet.0g.ai
ZEROG_STORAGE_INDEXER_RPC=https://indexer-storage-testnet-turbo.0g.ai
BROWSER_HEADLESS=false
ARTIFACT_RETENTION=keep
PAYOUT_ADDRESS=0x0000000000000000000000000000000000000000
```

## What Runs

- `npm run setup` tries to download the Gensyn AXL binary into `bin/axl-core/axl-client`. Because the public AXL repo currently has no release binaries, setup falls back to a local hackathon shim unless `REQUIRE_REAL_AXL=true` is set.
- `npm run setup` also creates `python-agent/venv`, installs `browser-use`, `langchain-openai`, `python-dotenv`, `reportlab`, and installs Playwright Chromium.
- `npm run check:0g` verifies your 0G testnet router API key against `https://router-api-testnet.integratenetwork.work/v1/chat/completions` before you spend time on a browser run.
- `npm start` launches the local Express orchestrator on `http://localhost:8080` and starts AXL with the hackathon flags:

```bash
bin/axl-core/axl-client \
  --network testnet \
  --identity "$ENS_IDENTITY" \
  --mcp-forward http://localhost:8080/mcp/execute
```

The package also exposes a CLI bin named `pookie-node`.

## Local API

Health check:

```bash
curl http://localhost:8080/health
```

Submit a WebOps task directly to the orchestrator:

```bash
curl -X POST http://localhost:8080/mcp/execute \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "task": "Find the page title and leave the browser on the evidence page.",
    "x402_sig": "demo-signature"
  }'
```

Successful responses look like:

```json
{
  "ok": true,
  "reportHash": "0x...",
  "reportUri": "0g://0x...",
  "reportPath": "artifacts/<requestId>/report.pdf",
  "artifactDir": "artifacts/<requestId>",
  "screenshots": ["artifacts/<requestId>/01-final.png"]
}
```

## Architecture

- **Networking:** Gensyn AXL binary handles mesh routing and forwards MCP payloads to the local orchestrator.
- **Orchestrator:** Node.js Express server validates the request shape, stubs x402 verification with `ethers`, runs the Python sidecar, and uploads the generated PDF report to 0G Storage.
- **Execution:** `python-agent/agent.py` uses `browser-use` against the 0G testnet OpenAI-compatible router at `https://router-api-testnet.integratenetwork.work/v1`.
- **Report:** The Python sidecar writes screenshots and `report.pdf` under `artifacts/<requestId>/`; Node returns the 0G Storage root hash and URI for the PDF.

## Current Hackathon Stubs

- KeeperHub x402 verification is a clearly marked stub in `src/server.js`.
- The AXL runtime uses the requested hackathon flags. Current public AXL docs also describe a config/router mode, so the CLI includes a note where that swap would happen.

## Troubleshooting

- **`npm run setup` cannot download AXL:** The default URL is a placeholder release path: `https://github.com/gensyn-ai/axl/releases/latest/download/axl-client-{platform}-{arch}`. Since the public AXL repo currently has no release binaries, setup creates a local shim so the demo can still boot. To require a real binary, run `REQUIRE_REAL_AXL=true npm run setup`.
- **Using a real AXL binary:** Build/download AXL manually and place it at `bin/axl-core/axl-client`, or rerun with `AXL_RELEASE_BASE_URL` pointing to a compatible release.
- **`npm start` says Python venv is missing:** Run `npm run setup`. If AXL download failed first, create the venv manually with `python3 -m venv python-agent/venv`, install `python-agent/requirements.txt`, and run `python-agent/venv/bin/python3 -m playwright install chromium`.
- **0G Storage upload fails before browser execution:** Confirm `.env` contains `ZEROG_PRIVATE_KEY`. Optional storage endpoint overrides are `ZEROG_STORAGE_RPC_URL` and `ZEROG_STORAGE_INDEXER_RPC`.
- **Browser task fails immediately:** Confirm `.env` contains a funded 0G testnet `ZEROG_API_KEY`, `ZEROG_BASE_URL=https://router-api-testnet.integratenetwork.work/v1`, and `ZEROG_MODEL=qwen/qwen-2.5-7b-instruct`.
- **Browser window does not appear:** By default the Python agent runs with a visible Chromium window. Set `BROWSER_HEADLESS=false` in `.env` for demos, or `BROWSER_HEADLESS=true` for background/headless runs.
- **Playwright complains Chromium is missing:** Run `python-agent/venv/bin/python3 -m playwright install chromium`.
- **AXL rejects CLI flags:** Replace the hackathon flag spawn in `bin/pookie.js` with the config/router mode described in the Gensyn AXL docs once the exact binary release shape is finalized.
