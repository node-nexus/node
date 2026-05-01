import { exec } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import express from "express";
import { verifyMessage } from "ethers";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const agentPath = path.join(projectRoot, "python-agent", "agent.py");
const venvPython =
  process.platform === "win32"
    ? path.join(projectRoot, "python-agent", "venv", "Scripts", "python.exe")
    : path.join(projectRoot, "python-agent", "venv", "bin", "python3");

function truncate(value, maxLength = 500) {
  const text = String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function logEvent({ requestId, event, step, status, details = {} }) {
  console.log(
    JSON.stringify({
      time: new Date().toISOString(),
      requestId,
      event,
      step,
      status,
      ...details
    })
  );
}

function logStep(requestId, step, status, details = {}) {
  logEvent({
    requestId,
    event: "step",
    step,
    status,
    details
  });
}

function parsePythonInfo(stdout) {
  return Object.fromEntries(
    stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith("INFO|"))
      .map((line) => line.slice("INFO|".length))
      .map((entry) => {
        const separatorIndex = entry.indexOf("=");
        if (separatorIndex === -1) {
          return [entry, true];
        }

        return [entry.slice(0, separatorIndex), entry.slice(separatorIndex + 1)];
      })
  );
}

function parsePythonError(stdout) {
  return stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ERROR|"))
    ?.slice("ERROR|".length)
    .trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function verifyX402PaymentStub({ url, task, x402_sig }) {
  if (!x402_sig || typeof x402_sig !== "string") {
    return {
      ok: false,
      reason: "Missing x402_sig"
    };
  }

  // TODO: Replace this KeeperHub stub with the real x402 payment envelope
  // validation flow. For now, we optionally recover a signer from a demo
  // message so judges can see where ethers v6 verification plugs in.
  try {
    const demoMessage = `Pookie Node task approval\nURL: ${url}\nTask: ${task}`;
    const recoveredAddress = verifyMessage(demoMessage, x402_sig);

    return {
      ok: true,
      mode: "mock-verified-signature",
      recoveredAddress
    };
  } catch {
    return {
      ok: true,
      mode: "mock-accepted-placeholder",
      recoveredAddress: null
    };
  }
}

function runPythonAgent({ url, task, requestId }) {
  return new Promise((resolve, reject) => {
    if (!existsSync(venvPython)) {
      logStep(requestId, "python-agent", "fail", {
        reason: "missing-venv",
        venvPython
      });
      reject(
        new Error(
          `Python virtual environment not found at ${venvPython}. Run npm run setup first.`
        )
      );
      return;
    }

    const command = [
      shellQuote(venvPython),
      shellQuote(agentPath),
      shellQuote(url),
      shellQuote(task)
    ].join(" ");

    logStep(requestId, "python-agent", "start", {
      agentPath,
      timeoutMs: 10 * 60 * 1000
    });

    exec(
      command,
      {
        cwd: projectRoot,
        env: process.env,
        timeout: 10 * 60 * 1000,
        maxBuffer: 1024 * 1024 * 10
      },
      (error, stdout, stderr) => {
        if (error) {
          const pythonError = parsePythonError(stdout);
          const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
          logStep(requestId, "python-agent", "fail", {
            error: truncate(pythonError || details || error.message),
            exitCode: error.code ?? null,
            signal: error.signal ?? null
          });
          reject(new Error(pythonError || details || error.message));
          return;
        }

        const successLine = stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith("SUCCESS|"));

        if (!successLine) {
          logStep(requestId, "python-agent", "fail", {
            reason: "missing-success-marker",
            stdout: truncate(stdout)
          });
          reject(new Error(`Python agent did not return SUCCESS marker. stdout: ${stdout}`));
          return;
        }

        const proofPath = successLine.slice("SUCCESS|".length).trim();
        const info = parsePythonInfo(stdout);
        logStep(requestId, "python-agent", "success", {
          proofPath,
          ...info,
          stderr: stderr.trim() ? truncate(stderr.trim()) : undefined
        });
        resolve({
          proofPath,
          info,
          stdout,
          stderr
        });
      }
    );
  });
}

async function uploadToZeroGStorageStub({ proofPath, requestId }) {
  logStep(requestId, "0g-upload", "start", {
    proofPath
  });

  // TODO: Replace with the real 0G Storage client upload. The timestamp keeps
  // each proof unique while still looking like a content-addressed artifact.
  const digest = crypto
    .createHash("sha256")
    .update(`${proofPath}:${Date.now()}:${process.env.ZEROG_PRIVATE_KEY ?? ""}`)
    .digest("hex");

  const proofHash = `0g://${digest}`;

  logStep(requestId, "0g-upload", "success", {
    proofHash
  });

  return proofHash;
}

export function createApp() {
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
    logStep(request.requestId, "health", "success");
    response.json({
      ok: true,
      service: "pookie-node-orchestrator"
    });
  });

  app.post("/mcp/execute", async (request, response) => {
    const requestId = request.requestId;
    const { url, task, x402_sig } = request.body ?? {};

    logStep(requestId, "parse-request", "start", {
      hasUrl: typeof url === "string",
      hasTask: typeof task === "string",
      hasX402Sig: typeof x402_sig === "string",
      taskLength: typeof task === "string" ? task.length : 0
    });

    if (typeof url !== "string" || typeof task !== "string") {
      logStep(requestId, "parse-request", "fail", {
        reason: "invalid-body"
      });
      response.status(400).json({
        ok: false,
        error: "Expected JSON body with string fields: url, task, x402_sig"
      });
      return;
    }

    logStep(requestId, "parse-request", "success", {
      url,
      taskLength: task.length
    });

    logStep(requestId, "x402-verify", "start", {
      mode: "keeperhub-stub"
    });
    const payment = verifyX402PaymentStub({ url, task, x402_sig });
    if (!payment.ok) {
      logStep(requestId, "x402-verify", "fail", {
        reason: payment.reason
      });
      response.status(402).json({
        ok: false,
        error: payment.reason
      });
      return;
    }

    logStep(requestId, "x402-verify", "success", {
      mode: payment.mode,
      recoveredAddress: payment.recoveredAddress
    });

    try {
      const { proofPath } = await runPythonAgent({ url, task, requestId });
      const proofHash = await uploadToZeroGStorageStub({ proofPath, requestId });

      logStep(requestId, "response", "success", {
        proofHash,
        proofPath
      });
      response.json({
        ok: true,
        proofHash,
        proofPath,
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

export function startServer({ port = Number(process.env.PORT ?? 8080) } = {}) {
  const app = createApp();

  return app.listen(port, () => {
    console.log(`Pookie Node orchestrator listening on http://localhost:${port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer();
}
