# Node Nexus

Node Nexus is a decentralized local WebOps network built around real user operated nodes.

It exists because current WebOps is broken in two ways: it either depends on centralized data centers that do not reflect real-world usage, or it depends on manual local testing that is too slow and too expensive to scale. Teams miss what users actually see across regions, including pricing, consent banners, redirects, search results, blocked content, and login friction.

Node Nexus fixes this by letting real operators run tasks from their own environments, return evidence rich reports, and get paid for contributing useful geographic coverage.

## Why This Needs AXL and 0G

This product only works properly because of the combination of Gensyn AXL and 0G.

### Why AXL is needed

Node Nexus is a network of independent operator nodes. Those nodes need to discover each other, exchange metadata, receive remote tasks, and return reports across separate machines. That requires inter node communication.

AXL provides the communication layer for this. It is what makes it possible for Node Nexus to operate as a decentralized node network.

### Why 0G is needed

Node Nexus also needs an economic layer, an AI layer, and a durable artifact layer.

0G provides all three:

- payments for operator nodes
- AI inference through the 0G router
- report and metadata persistence through 0G Storage

Without 0G, operators could still run browser tasks, but there would be no integrated decentralized way to pay nodes, power inference, and persist outputs.

## Project Info

Node Nexus is designed as a decentralized operator network for local web testing and evidence collection.

Each node can:

- receive browser based WebOps tasks
- execute them locally
- capture screenshots and structured observations
- generate a PDF report
- return report results to the network

The system combines:

- a Node.js and Express service for orchestration and node APIs
- a Python execution agent for browser automation and report generation
- a Next.js frontend for task submission and report access
- operator metadata including location, capabilities, and payment details

## 0G Integration

Node Nexus uses 0G in three ways.

### Payments

Operator nodes publish a 0G payment address and minimum task price in their node profile. Selected node payments are verified onchain before work is dispatched.

### AI Inference

The browser execution stack uses Qwen through the 0G OpenAI compatible router for task reasoning, report support, and optional peer-selection logic.

### Storage

Generated report artifacts are uploaded to 0G Storage. Node Nexus stores the PDF report and metadata on 0G and returns `0g://` URIs plus download links.

## AXL Integration

Node Nexus uses Gensyn AXL for inter node communication.

AXL is used to:

- discover live peers
- exchange node profile information
- send remote execution tasks between nodes
- return asynchronous reports over the mesh

## Setup

Install dependencies and create local config:

```bash
npm install
cp .env.example .env
cp config/node-profile.example.json config/node-profile.json
npm run setup
```

Then edit:

- `.env`
- `config/node-profile.json`

Your node profile should include:

- node ID
- display name
- real location
- supported capabilities
- 0G payment wallet address
- minimum task amount

Your `.env` should include real values for:

- `AXL_IDENTITY`
- `ZEROG_API_KEY`
- `ZERO_G_PRIVATE_KEY`
- `ZERO_G_STORAGE_RPC_URL`
- `ZERO_G_STORAGE_INDEXER_URL`

Optional check:

```bash
npm run check:0g
```

## Run With Everything Enabled

```bash
AXL_MODE=real \
AXL_BINARY_PATH=bin/axl-core/node \
AXL_CONFIG_PATH=bin/axl-core/node-config.json \
AXL_NETWORK=testnet \
AXL_IDENTITY=node-identity \
AXL_MCP_FORWARD_URL=http://localhost:8080/mcp/execute \
ZERO_G_UPLOAD_MODE=real \
ZERO_G_STORAGE_RPC_URL=https://evmrpc-testnet.0g.ai \
ZERO_G_STORAGE_INDEXER_URL=https://indexer-storage-testnet-turbo.0g.ai \
ZERO_G_PRIVATE_KEY=your_private_key \
ZERO_G_PAYMENT_RPC_URL=https://evmrpc-testnet.0g.ai \
ZEROG_API_KEY=your_0g_testnet_router_api_key \
ZEROG_MODEL=qwen/qwen-2.5-7b-instruct \
ZEROG_BASE_URL=https://router-api-testnet.integratenetwork.work/v1 \
npm start
```

Optional frontend:

```bash
NEXT_PUBLIC_NODE_NEXUS_API_URL=http://localhost:8080 npm run web:dev
```

## Operator Output

When a task completes, the node produces artifacts under:

```text
artifacts/<taskId>/
```

This typically includes:

- `report.pdf`
- `metadata.json`
- screenshots captured during execution
