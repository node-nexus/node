import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";

import { applyArtifactRetention } from "./artifacts.js";
import { axlClientConfig, callAxlMcp, getAxlTopology } from "./axlClient.js";
import { GatewayStore } from "./gatewayStore.js";
import { logEvent, logStep, truncate } from "./logging.js";
import { nodeLocation } from "./nodeProfile.js";
import { runPythonAgent } from "./pythonAgent.js";
import {
  uploadReportToZeroGStorage,
  validateZeroGStorageConfig
} from "./zeroGStorage.js";
import { qwenSelectionConfigured, selectPeersWithQwen } from "./qwenSelection.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), "..");
const artifactsRoot = path.join(projectRoot, "artifacts");

const DEFAULT_PROFILE = {
  nodeId: "node-nexus-unconfigured",
  displayName: "Node Nexus Unconfigured",
  country: "UNCONFIGURED",
  region: "",
  city: "",
  timezone: "UTC",
  capabilities: []
};

function buildPaymentCompatibility(x402_sig) {
  return {
    ok: true,
    mode: typeof x402_sig === "string" ? "compatibility-sig-present" : "not-required",
    note: "Node Nexus skips external payment identity integrations in this pass."
  };
}

function sanitizeTaskId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 120);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function parseRouteRequest(value) {
  if (typeof value === "string") {
    return JSON.parse(value);
  }
  return value;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function unwrapJsonRpcResponse(value) {
  const rpc = value?.response ?? value;
  if (rpc?.error) {
    throw new Error(rpc.error.message || JSON.stringify(rpc.error));
  }
  return rpc?.result ?? rpc;
}

function peerIdsFromTopology(topology) {
  const own = topology?.our_public_key;
  const fromPeers = Array.isArray(topology?.peers)
    ? topology.peers
        .filter((peer) => peer?.up !== false)
        .map((peer) => peer?.public_key)
    : [];
  const fromTree = Array.isArray(topology?.tree) ? topology.tree.map((entry) => entry?.public_key) : [];
  return unique([...fromPeers, ...fromTree]).filter((peerId) => peerId && peerId !== own);
}

function normalizeLocationFilter(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function locationMatches(node, targetLocations) {
  if (!targetLocations.length) {
    return true;
  }

  const location = node.location ?? {};
  const haystack = [
    location.country,
    location.region,
    location.city,
    location.timezone,
    node.nodeId,
    node.displayName
  ]
    .map(normalizeLocationFilter)
    .filter(Boolean);

  return targetLocations.some((target) => haystack.includes(normalizeLocationFilter(target)));
}

function hasWebOpsCapability(node) {
  const capabilities = new Set((node.capabilities ?? []).map((capability) => String(capability).toLowerCase()));
  return capabilities.has("browser-use") || capabilities.has("qwen-agent") || capabilities.has("pdf-report");
}

function deterministicPeerSelection({ candidates, targetLocations, maxTargets }) {
  const eligible = candidates.filter((candidate) => locationMatches(candidate, targetLocations));
  const pool = eligible.length ? eligible : candidates;
  return pool
    .slice()
    .sort((left, right) => {
      const leftCapable = hasWebOpsCapability(left) ? 1 : 0;
      const rightCapable = hasWebOpsCapability(right) ? 1 : 0;
      if (leftCapable !== rightCapable) {
        return rightCapable - leftCapable;
      }
      return left.peerId.localeCompare(right.peerId);
    })
    .slice(0, maxTargets);
}

export function createApp({
  nodeProfile = DEFAULT_PROFILE,
  axlStatusProvider = () => null,
  gatewayStore = new GatewayStore()
} = {}) {
  const app = express();

  function resolveArtifactPath(relativePath) {
    const resolved = path.resolve(projectRoot, String(relativePath ?? ""));
    if (resolved === artifactsRoot || resolved.startsWith(`${artifactsRoot}${path.sep}`)) {
      return resolved;
    }
    return null;
  }

  function absoluteDownloadUrl(request, relativePath) {
    if (!relativePath) {
      return null;
    }
    const host = request?.get?.("host");
    if (!host) {
      return `/${String(relativePath).replace(/^\/+/, "")}`;
    }
    return `${request.protocol}://${host}/${String(relativePath).replace(/^\/+/, "")}`;
  }

  app.use((request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", process.env.NODE_NEXUS_CORS_ORIGIN ?? "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }

    next();
  });

  app.use(express.json({ limit: "2mb" }));

  app.get("/artifacts/:taskId/:fileName", (request, response) => {
    const relativePath = path.posix.join("artifacts", request.params.taskId, request.params.fileName);
    const absolutePath = resolveArtifactPath(relativePath);

    if (!absolutePath) {
      response.status(400).json({ ok: false, error: "Invalid artifact path." });
      return;
    }

    response.sendFile(absolutePath, (error) => {
      if (!error) {
        return;
      }
      response.status(error.statusCode || 404).json({
        ok: false,
        error: "Artifact not found."
      });
    });
  });

  app.use((request, response, next) => {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    request.requestId = requestId;

    logEvent({
      requestId,
      event: "request",
      status: "received",
      details: {
        method: request.method,
        path: request.path,
        ip: request.ip
      }
    });

    response.on("finish", () => {
      logEvent({
        requestId,
        event: "request",
        status: response.statusCode >= 400 ? "fail" : "success",
        details: {
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
          durationMs: Date.now() - startedAt
        }
      });
    });

    next();
  });

  async function executeWebOpsTask({ requestId, body, request = null }) {
    const {
      taskId: submittedTaskId,
      url,
      task,
      x402_sig,
      reportType = "webops-local-ux",
      requestedBy = null,
      targetLocation = null
    } = body ?? {};
    const taskId = sanitizeTaskId(submittedTaskId) || requestId;

    logStep(requestId, "parse-request", "start", {
      taskId,
      hasUrl: typeof url === "string",
      hasTask: typeof task === "string",
      hasX402Sig: typeof x402_sig === "string",
      taskLength: typeof task === "string" ? task.length : 0,
      reportType,
      requestedBy,
      targetLocation
    });

    if (typeof url !== "string" || typeof task !== "string") {
      logStep(requestId, "parse-request", "fail", { reason: "invalid-body" });
      const error = new Error("Expected JSON body with string fields: url and task");
      error.statusCode = 400;
      throw error;
    }

    logStep(requestId, "parse-request", "success", {
      url,
      taskId,
      taskLength: task.length
    });

    const payment = buildPaymentCompatibility(x402_sig);
    logStep(requestId, "x402-compatibility", "success", { mode: payment.mode });

    const storageValidation = validateZeroGStorageConfig();
    if (!storageValidation.ok) {
      logStep(requestId, "0g-storage-config", "fail", {
        missing: storageValidation.missing
      });
      const error = new Error("0G upload requested but missing ZERO_G_* env vars.");
      error.statusCode = 500;
      throw error;
    }

    logStep(requestId, "0g-storage-config", "success", {
      uploadMode: storageValidation.config.uploadMode,
      storageRpcUrl: storageValidation.config.storageRpcUrl,
      storageIndexerRpc: storageValidation.config.storageIndexerRpc
    });

    const agentResult = await runPythonAgent({
      url,
      task,
      requestId,
      taskId,
      nodeProfile,
      reportType,
      requestedBy,
      targetLocation
    });

    logStep(requestId, "0g-upload", "start", {
      reportPath: agentResult.reportPath,
      metadataPath: agentResult.metadataPath,
      uploadMode: storageValidation.config.uploadMode
    });
    const upload = await uploadReportToZeroGStorage({
      reportPath: agentResult.reportPath,
      metadataPath: agentResult.metadataPath
    });
    logStep(requestId, "0g-upload", "success", {
      reportHash: upload.reportHash,
      reportUri: upload.reportUri,
      metadataUri: upload.metadataUri,
      txHash: upload.txHash,
      uploadMode: upload.uploadMode
    });
    applyArtifactRetention({ screenshots: agentResult.screenshots });

    const localReportDownloadUrl = absoluteDownloadUrl(request, agentResult.reportPath);

    const reportUri = upload.reportDownloadUrl ?? upload.reportUri;

    return {
      ok: true,
      taskId,
      requestId,
      nodeId: nodeProfile.nodeId,
      location: nodeLocation(nodeProfile),
      status: agentResult.status ?? "completed",
      summary: agentResult.summary ?? "",
      finalUrl: agentResult.finalUrl,
      artifactDir: agentResult.artifactDir,
      screenshots: agentResult.screenshots,
      reportPath: agentResult.reportPath,
      metadataPath: agentResult.metadataPath,
      reportHash: upload.reportHash,
      reportUri,
      reportZeroGUri: upload.reportUri,
      zeroGReportDownloadUrl: upload.reportDownloadUrl ?? null,
      reportDownloadUrl: localReportDownloadUrl,
      reportLinks: {
        localPath: agentResult.reportPath,
        localDownloadUrl: localReportDownloadUrl,
        zeroGUri: upload.reportUri,
        zeroGDownloadUrl: upload.reportDownloadUrl ?? null
      },
      zeroG: upload,
      payment
    };
  }

  async function dispatchGatewayTask({ taskId, url, task, reportType, targetNodes, targetLocations }) {
    const axl = axlStatusProvider() ?? { mode: "disabled" };
    if (axl.mode === "disabled") {
      gatewayStore.setTaskStatus(taskId, "failed");
      gatewayStore.addReport({
        taskId,
        status: "failed",
        error: "AXL is disabled; gateway dispatch requires AXL_MODE=real or AXL_MODE=mock."
      });
      return;
    }

    if (axl.mode === "mock") {
      gatewayStore.setTaskStatus(taskId, "completed");
      for (const peerId of targetNodes) {
        gatewayStore.addReport({
          taskId,
          peerId,
          nodeId: `mock-${peerId.slice(0, 8)}`,
          status: "mock-dispatched",
          summary: "AXL mock mode recorded this dispatch without remote mesh delivery.",
          response: { mock: true, taskId, peerId }
        });
      }
      return;
    }

    gatewayStore.setTaskStatus(taskId, "dispatching");
    let failures = 0;

    for (const peerId of targetNodes) {
      const rpcRequest = {
        jsonrpc: "2.0",
        method: "node_nexus.execute",
        id: `${taskId}:${peerId}`,
        params: {
          taskId,
          url,
          task,
          reportType,
          requestedBy: nodeProfile.nodeId,
          asyncReport: true,
          targetLocation: targetLocations.join(",")
        }
      };

      try {
        const rpcResponse = await callAxlMcp({
          peerId,
          service: process.env.NODE_NEXUS_MCP_SERVICE || "node-nexus",
          request: rpcRequest
        });

        const result = unwrapJsonRpcResponse(rpcResponse);
        gatewayStore.addReport({
          taskId,
          peerId,
          nodeId: result?.nodeId,
          location: result?.location,
          status: result?.status || "accepted",
          summary: result?.summary,
          finalUrl: result?.finalUrl,
          reportUri: result?.reportUri,
          reportPath: result?.reportPath,
          metadataPath: result?.metadataPath,
          response: result
        });
      } catch (error) {
        failures += 1;
        gatewayStore.addReport({
          taskId,
          peerId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    gatewayStore.setTaskStatus(taskId, failures === targetNodes.length ? "failed" : "dispatching");
  }

  function updateGatewayTaskStatusFromReports(taskId) {
    const task = gatewayStore.getTask(taskId);
    if (!task) {
      return;
    }

    const terminalReports = task.reports.filter((report) =>
      ["completed", "partial", "failed"].includes(report.status)
    );
    const successfulPeers = new Set(
      terminalReports
        .filter((report) => report.status !== "failed")
        .map((report) => report.peerId)
        .filter(Boolean)
    );
    const failedPeers = new Set(
      terminalReports
        .filter((report) => report.status === "failed")
        .map((report) => report.peerId)
        .filter(Boolean)
    );
    const targetNodes = task.targetNodes ?? [];

    if (targetNodes.length && successfulPeers.size >= targetNodes.length) {
      gatewayStore.setTaskStatus(taskId, "completed");
      return;
    }

    if (targetNodes.length && successfulPeers.size + failedPeers.size >= targetNodes.length) {
      gatewayStore.setTaskStatus(taskId, successfulPeers.size ? "partial" : "failed");
    }
  }

  async function sendAsyncReport({ targetPeerId, rpcId, result = null, error = null }) {
    if (!targetPeerId) {
      throw new Error("Cannot send async report without AXL sender peer id.");
    }

    let ownPeerId = null;
    try {
      ownPeerId = (await getAxlTopology())?.our_public_key ?? null;
    } catch {
      ownPeerId = null;
    }

    const params = error
      ? {
          taskId: result?.taskId,
          peerId: ownPeerId,
          nodeId: nodeProfile.nodeId,
          location: nodeLocation(nodeProfile),
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        }
      : {
          peerId: ownPeerId,
          ...result,
          status: result?.status || "completed"
        };

    await callAxlMcp({
      peerId: targetPeerId,
      service: process.env.NODE_NEXUS_MCP_SERVICE || "node-nexus",
      request: {
        jsonrpc: "2.0",
        method: "node_nexus.report",
        id: `report:${rpcId ?? params.taskId ?? crypto.randomUUID()}`,
        params
      }
    });
  }

  async function discoverLivePeers({ includeProfiles = true } = {}) {
    const axl = axlStatusProvider() ?? { mode: "disabled" };

    if (axl.mode === "disabled") {
      return {
        ok: false,
        mode: axl.mode,
        topology: null,
        nodes: [],
        error: "AXL is disabled; live peer discovery requires AXL_MODE=real or AXL_MODE=mock."
      };
    }

    if (axl.mode === "mock") {
      const nodes = [
        {
          peerId: "mock-node-nexus-peer-in-001",
          nodeId: "mock-node-nexus-in",
          displayName: "Mock Node Nexus IN",
          location: { country: "IN", region: "Maharashtra", city: "Mumbai", timezone: "Asia/Kolkata" },
          capabilities: ["browser-use", "qwen-agent", "screenshots", "pdf-report", "0g-storage-upload"],
          profileStatus: "mock"
        },
        {
          peerId: "mock-node-nexus-peer-us-001",
          nodeId: "mock-node-nexus-us",
          displayName: "Mock Node Nexus US",
          location: { country: "US", region: "NY", city: "New York", timezone: "America/New_York" },
          capabilities: ["browser-use", "qwen-agent", "screenshots", "pdf-report", "0g-storage-upload"],
          profileStatus: "mock"
        }
      ];

      return { ok: true, mode: axl.mode, topology: null, nodes, discoveredAt: new Date().toISOString() };
    }

    const topology = await getAxlTopology();
    const peerIds = peerIdsFromTopology(topology);

    if (!includeProfiles) {
      return {
        ok: true,
        mode: axl.mode,
        topology,
        nodes: peerIds.map((peerId) => ({ peerId, profileStatus: "not-probed" })),
        discoveredAt: new Date().toISOString()
      };
    }

    const nodes = await Promise.all(
      peerIds.map(async (peerId) => {
        try {
          const rpcResponse = await callAxlMcp({
            peerId,
            service: process.env.NODE_NEXUS_MCP_SERVICE || "node-nexus",
            request: {
              jsonrpc: "2.0",
              method: "node_nexus.profile",
              id: `profile:${peerId}`,
              params: {}
            }
          });
          const result = unwrapJsonRpcResponse(rpcResponse);
          const profile = result?.nodeProfile ?? result?.profile ?? {};
          return {
            peerId,
            nodeId: profile.nodeId,
            displayName: profile.displayName,
            location: result?.location ?? nodeLocation(profile),
            capabilities: profile.capabilities ?? [],
            profile,
            profileStatus: "available"
          };
        } catch (error) {
          return {
            peerId,
            profileStatus: "unavailable",
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );

    return { ok: true, mode: axl.mode, topology, nodes, discoveredAt: new Date().toISOString() };
  }

  async function selectGatewayTargets({ url, task, targetNodes, targetLocations, selectionMode, maxTargets }) {
    if (targetNodes.length) {
      return {
        targetNodes,
        discovery: null,
        selection: { mode: "manual", selectedPeerIds: targetNodes, rationale: "Requester supplied explicit peer IDs." }
      };
    }

    const discovery = await discoverLivePeers({ includeProfiles: true });
    if (!discovery.ok) {
      throw new Error(discovery.error || "Live peer discovery failed.");
    }

    const available = discovery.nodes.filter((node) => node.profileStatus === "available" || node.profileStatus === "mock");
    const selectedCount = Math.max(1, Math.min(Number(maxTargets || 1), available.length || 1));

    if (!available.length) {
      throw new Error("No available Node Nexus peers responded to live discovery.");
    }

    if (selectionMode === "ai") {
      try {
        const qwenSelection = await selectPeersWithQwen({
          url,
          task,
          targetLocations,
          candidates: available,
          maxTargets: selectedCount
        });

        if (qwenSelection.selectedPeerIds.length) {
          return {
            targetNodes: qwenSelection.selectedPeerIds,
            discovery,
            selection: { mode: "ai", ...qwenSelection }
          };
        }
      } catch (error) {
        const selected = deterministicPeerSelection({ candidates: available, targetLocations, maxTargets: selectedCount });
        return {
          targetNodes: selected.map((node) => node.peerId),
          discovery,
          selection: {
            mode: "auto-fallback",
            selectedPeerIds: selected.map((node) => node.peerId),
            rationale: error instanceof Error ? error.message : String(error)
          }
        };
      }
    }

    const selected = deterministicPeerSelection({ candidates: available, targetLocations, maxTargets: selectedCount });
    return {
      targetNodes: selected.map((node) => node.peerId),
      discovery,
      selection: {
        mode: "auto",
        selectedPeerIds: selected.map((node) => node.peerId),
        rationale: targetLocations.length
          ? "Selected live peers matching requested locations when available."
          : "Selected live peers from fresh AXL discovery."
      }
    };
  }

  async function createGatewayTask(request, response) {
    const taskId = sanitizeTaskId(request.body?.taskId) || crypto.randomUUID();
    const { url, task, reportType = "webops-local-ux", selectionMode = "auto" } = request.body ?? {};
    const targetNodes = Array.isArray(request.body?.targetNodes) ? request.body.targetNodes.filter(Boolean) : [];
    const targetLocations = Array.isArray(request.body?.targetLocations)
      ? request.body.targetLocations.filter(Boolean)
      : [];
    const maxTargets = Number(request.body?.maxTargets ?? request.body?.targetCount ?? 1);
    const axl = axlStatusProvider() ?? { mode: "disabled" };

    if (typeof url !== "string" || typeof task !== "string") {
      response.status(400).json({
        ok: false,
        error: "Expected url and task."
      });
      return;
    }

    let selected;
    try {
      selected = await selectGatewayTargets({
        url,
        task,
        targetNodes,
        targetLocations,
        selectionMode,
        maxTargets
      });
    } catch (error) {
      response.status(axl.mode === "disabled" ? 503 : 502).json({
        ok: false,
        mode: axl.mode,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    try {
      gatewayStore.createTask({
        taskId,
        url,
        task,
        reportType,
        targetNodes: selected.targetNodes,
        targetLocations,
        request: {
          ...(request.body ?? {}),
          targetNodes: selected.targetNodes,
          discoveryStored: false,
          selection: selected.selection
        }
      });
    } catch {
      response.status(409).json({
        ok: false,
        error: `Task ${taskId} already exists.`
      });
      return;
    }

    void dispatchGatewayTask({ taskId, url, task, reportType, targetNodes: selected.targetNodes, targetLocations });

    response.status(axl.mode === "disabled" ? 503 : 202).json({
      ok: axl.mode !== "disabled",
      mode: axl.mode,
      taskId,
      targetNodes: selected.targetNodes,
      selection: selected.selection,
      status: axl.mode === "disabled" ? "failed" : "queued",
      error:
        axl.mode === "disabled"
          ? "AXL is disabled; dispatch requires AXL_MODE=real or AXL_MODE=mock."
          : undefined
    });
  }

  app.get("/health", (request, response) => {
    const zeroGValidation = validateZeroGStorageConfig();
    logStep(request.requestId, "health", "success");
    response.json({
      ok: true,
      service: "node-nexus-orchestrator",
      role: process.env.NODE_NEXUS_ROLE || "local",
      nodeProfile,
      axl: {
        ...axlStatusProvider(),
        client: axlClientConfig()
      },
      zeroG: {
        uploadMode: zeroGValidation.config.uploadMode,
        configured: zeroGValidation.ok,
        missing: zeroGValidation.missing
      },
      qwenSelection: {
        configured: qwenSelectionConfigured()
      }
    });
  });

  app.get("/node/profile", (request, response) => {
    logStep(request.requestId, "node-profile", "success");
    response.json({ ok: true, nodeProfile });
  });

  app.get("/axl/status", (request, response) => {
    logStep(request.requestId, "axl-status", "success");
    response.json({ ok: true, axl: { ...axlStatusProvider(), client: axlClientConfig() } });
  });

  app.get("/axl/peers", async (request, response) => {
    const axl = axlStatusProvider() ?? { mode: "disabled" };
    if (axl.mode !== "real") {
      response.json({
        ok: true,
        mode: axl.mode,
        topology: null,
        nodes: []
      });
      return;
    }

    try {
      response.json({
        ok: true,
        mode: axl.mode,
        topology: await getAxlTopology(),
        nodes: []
      });
    } catch (error) {
      response.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.get("/gateway/peers", async (request, response) => {
    try {
      const includeProfiles = request.query.profiles !== "false";
      response.json(await discoverLivePeers({ includeProfiles }));
    } catch (error) {
      response.status(502).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  app.post("/axl/dispatch", createGatewayTask);
  app.get("/axl/tasks/:taskId", (request, response) => {
    const task = gatewayStore.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ ok: false, error: "AXL task not found on this local node." });
      return;
    }
    response.json({ ok: true, task });
  });
  app.get("/axl/tasks/:taskId/reports", (request, response) => {
    const task = gatewayStore.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ ok: false, error: "AXL task not found on this local node." });
      return;
    }
    response.json({ ok: true, taskId: request.params.taskId, reports: gatewayStore.listReports(request.params.taskId) });
  });

  app.post("/gateway/tasks", createGatewayTask);
  app.get("/gateway/tasks", (request, response) => {
    response.json({
      ok: true,
      tasks: gatewayStore.listTasks({ limit: Number(request.query.limit ?? 50) })
    });
  });
  app.get("/gateway/tasks/:taskId", (request, response) => {
    const task = gatewayStore.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ ok: false, error: "Gateway task not found." });
      return;
    }
    response.json({ ok: true, task });
  });
  app.get("/gateway/tasks/:taskId/reports", (request, response) => {
    const task = gatewayStore.getTask(request.params.taskId);
    if (!task) {
      response.status(404).json({ ok: false, error: "Gateway task not found." });
      return;
    }
    response.json({ ok: true, taskId: request.params.taskId, reports: gatewayStore.listReports(request.params.taskId) });
  });
  app.post("/gateway/nodes", (request, response) => {
    response.status(410).json({
      ok: false,
      error: "Persistent node registration is disabled. Use live AXL discovery via GET /gateway/peers."
    });
  });
  app.get("/gateway/nodes", (request, response) => {
    response.status(410).json({
      ok: false,
      nodes: [],
      error: "Persistent node lists are disabled. Use live AXL discovery via GET /gateway/peers."
    });
  });

  app.post("/route", async (request, response) => {
    let rpc;
    const serviceName = process.env.NODE_NEXUS_MCP_SERVICE || "node-nexus";
    try {
      rpc = parseRouteRequest(request.body?.request);
    } catch {
      response.status(400).json({ response: null, error: "Invalid JSON-RPC request in route envelope." });
      return;
    }

    if (request.body?.service !== serviceName) {
      response.status(404).json({ response: null, error: `Unknown Node Nexus service: ${request.body?.service}` });
      return;
    }

    try {
      if (rpc?.method === "node_nexus.profile") {
        response.json({
          response: jsonRpcResult(rpc.id, { nodeProfile, location: nodeLocation(nodeProfile) }),
          error: ""
        });
        return;
      }

      if (rpc?.method === "node_nexus.report") {
        const params = rpc.params ?? {};
        gatewayStore.addReport({
          taskId: params.taskId,
          peerId: params.peerId || request.body?.from_peer_id,
          nodeId: params.nodeId,
          location: params.location,
          status: params.status || "completed",
          summary: params.summary,
          finalUrl: params.finalUrl,
          reportUri: params.reportUri,
          reportPath: params.reportPath,
          metadataPath: params.metadataPath,
          response: params,
          error: params.error
        });
        updateGatewayTaskStatusFromReports(params.taskId);
        response.json({ response: jsonRpcResult(rpc.id, { ok: true }), error: "" });
        return;
      }

      if (rpc?.method !== "node_nexus.execute") {
        response.json({
          response: jsonRpcError(rpc?.id ?? null, -32601, `Unsupported method: ${rpc?.method}`),
          error: ""
        });
        return;
      }

      if (rpc?.params?.asyncReport) {
        const replyPeerId = request.body?.from_peer_id;
        response.json({
          response: jsonRpcResult(rpc.id, {
            ok: true,
            taskId: rpc.params.taskId,
            nodeId: nodeProfile.nodeId,
            location: nodeLocation(nodeProfile),
            status: "accepted",
            asyncReport: true,
            summary: "Node Nexus operator accepted the task and will return the report asynchronously."
          }),
          error: ""
        });

        void executeWebOpsTask({ requestId: request.requestId, body: rpc.params, request })
          .then((result) => sendAsyncReport({ targetPeerId: replyPeerId, rpcId: rpc.id, result }))
          .catch((error) =>
            sendAsyncReport({
              targetPeerId: replyPeerId,
              rpcId: rpc.id,
              result: { taskId: rpc.params?.taskId },
              error
            }).catch((reportError) => {
              logStep(request.requestId, "async-report", "fail", {
                error: truncate(reportError instanceof Error ? reportError.message : String(reportError))
              });
            })
          );
        return;
      }

      const result = await executeWebOpsTask({ requestId: request.requestId, body: rpc.params, request });
      response.json({ response: jsonRpcResult(rpc.id, result), error: "" });
    } catch (error) {
      response.json({
        response: jsonRpcError(rpc?.id ?? null, -32000, error instanceof Error ? error.message : String(error)),
        error: ""
      });
    }
  });

  app.post("/mcp/execute", async (request, response) => {
    try {
      response.json(await executeWebOpsTask({ requestId: request.requestId, body: request.body, request }));
    } catch (error) {
      logStep(request.requestId, "response", "fail", {
        error: truncate(error instanceof Error ? error.message : String(error))
      });
      response.status(error.statusCode || 500).json({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  return app;
}

export function startServer({
  port = Number(process.env.PORT ?? 8080),
  nodeProfile,
  axlStatusProvider
} = {}) {
  const app = createApp({ nodeProfile, axlStatusProvider });

  return app.listen(port, () => {
    console.log(`Node Nexus orchestrator listening on http://localhost:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}
