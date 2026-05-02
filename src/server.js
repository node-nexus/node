import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";

import { applyArtifactRetention } from "./artifacts.js";
import { logEvent, logStep, truncate } from "./logging.js";
import { nodeLocation } from "./nodeProfile.js";
import { runPythonAgent } from "./pythonAgent.js";
import {
  uploadReportToZeroGStorage,
  validateZeroGStorageConfig
} from "./zeroGStorage.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);

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

const DEFAULT_PROFILE = {
  nodeId: "node-nexus-unconfigured",
  displayName: "Node Nexus Unconfigured",
  country: "UNCONFIGURED",
  region: "",
  city: "",
  timezone: "UTC",
  capabilities: []
};

export function createApp({ nodeProfile = DEFAULT_PROFILE, axlStatusProvider = () => null } = {}) {
  const axlTasks = new Map();
  const app = express();

  app.use(express.json({ limit: "1mb" }));

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

  app.get("/health", (request, response) => {
    const zeroGValidation = validateZeroGStorageConfig();
    logStep(request.requestId, "health", "success");
    response.json({
      ok: true,
      service: "node-nexus-orchestrator",
      nodeProfile,
      axl: axlStatusProvider(),
      zeroG: {
        uploadMode: zeroGValidation.config.uploadMode,
        configured: zeroGValidation.ok,
        missing: zeroGValidation.missing
      }
    });
  });

  app.get("/node/profile", (request, response) => {
    logStep(request.requestId, "node-profile", "success");
    response.json({
      ok: true,
      nodeProfile
    });
  });

  app.get("/axl/status", (request, response) => {
    logStep(request.requestId, "axl-status", "success");
    response.json({
      ok: true,
      axl: axlStatusProvider()
    });
  });

  app.get("/axl/peers", (request, response) => {
    const axl = axlStatusProvider() ?? { mode: "disabled" };
    const isReal = axl.mode === "real";
    logStep(request.requestId, "axl-peers", isReal ? "fail" : "success", {
      mode: axl.mode
    });
    response.status(isReal ? 501 : 200).json({
      ok: !isReal,
      mode: axl.mode,
      peers: axl.mode === "mock" ? [] : undefined,
      error: isReal ? "AXL peers require real AXL local API configuration." : undefined
    });
  });

  app.post("/axl/dispatch", (request, response) => {
    const axl = axlStatusProvider() ?? { mode: "disabled" };
    const taskId = sanitizeTaskId(request.body?.taskId) || crypto.randomUUID();

    if (axl.mode === "mock") {
      const record = {
        taskId,
        mode: "mock",
        status: "mock-dispatch-created",
        request: request.body ?? {},
        reports: [],
        createdAt: new Date().toISOString()
      };
      axlTasks.set(taskId, record);
      response.json({
        ok: true,
        mock: true,
        taskId,
        status: record.status,
        message: "AXL mock mode accepted dispatch without remote mesh delivery."
      });
      return;
    }

    response.status(axl.mode === "real" ? 501 : 503).json({
      ok: false,
      taskId,
      error:
        axl.mode === "real"
          ? "AXL dispatch requires real AXL local API configuration."
          : "AXL is disabled; dispatch requires AXL_MODE=real or AXL_MODE=mock."
    });
  });

  app.get("/axl/tasks/:taskId", (request, response) => {
    const record = axlTasks.get(request.params.taskId);
    if (!record) {
      response.status(404).json({
        ok: false,
        error: "AXL task not found on this local node."
      });
      return;
    }

    response.json({
      ok: true,
      task: record
    });
  });

  app.get("/axl/tasks/:taskId/reports", (request, response) => {
    const record = axlTasks.get(request.params.taskId);
    if (!record) {
      response.status(404).json({
        ok: false,
        error: "AXL task not found on this local node."
      });
      return;
    }

    response.json({
      ok: true,
      taskId: request.params.taskId,
      reports: record.reports
    });
  });

  app.post("/mcp/execute", async (request, response) => {
    const requestId = request.requestId;
    const {
      taskId: submittedTaskId,
      url,
      task,
      x402_sig,
      reportType = "webops-local-ux",
      requestedBy = null,
      targetLocation = null
    } = request.body ?? {};
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
      logStep(requestId, "parse-request", "fail", {
        reason: "invalid-body"
      });
      response.status(400).json({
        ok: false,
        error: "Expected JSON body with string fields: url and task"
      });
      return;
    }

    logStep(requestId, "parse-request", "success", {
      url,
      taskId,
      taskLength: task.length
    });

    const payment = buildPaymentCompatibility(x402_sig);
    logStep(requestId, "x402-compatibility", "success", {
      mode: payment.mode
    });

    const storageValidation = validateZeroGStorageConfig();
    if (!storageValidation.ok) {
      logStep(requestId, "0g-storage-config", "fail", {
        missing: storageValidation.missing
      });
      response.status(500).json({
        ok: false,
        error: "0G upload requested but missing ZERO_G_* env vars."
      });
      return;
    }

    logStep(requestId, "0g-storage-config", "success", {
      uploadMode: storageValidation.config.uploadMode,
      storageRpcUrl: storageValidation.config.storageRpcUrl,
      storageIndexerRpc: storageValidation.config.storageIndexerRpc
    });

    try {
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
      applyArtifactRetention({
        screenshots: agentResult.screenshots
      });

      response.json({
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
        reportUri: upload.reportUri,
        zeroG: upload,
        payment
      });
    } catch (error) {
      logStep(requestId, "response", "fail", {
        error: truncate(error instanceof Error ? error.message : String(error))
      });
      response.status(500).json({
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
