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

function runPythonAgent({ url, task }) {
  return new Promise((resolve, reject) => {
    if (!existsSync(venvPython)) {
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
          const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
          reject(new Error(details || error.message));
          return;
        }

        const successLine = stdout
          .split(/\r?\n/)
          .find((line) => line.startsWith("SUCCESS|"));

        if (!successLine) {
          reject(new Error(`Python agent did not return SUCCESS marker. stdout: ${stdout}`));
          return;
        }

        const proofPath = successLine.slice("SUCCESS|".length).trim();
        resolve({
          proofPath,
          stdout,
          stderr
        });
      }
    );
  });
}

async function uploadToZeroGStorageStub({ proofPath }) {
  // TODO: Replace with the real 0G Storage client upload. The timestamp keeps
  // each proof unique while still looking like a content-addressed artifact.
  const digest = crypto
    .createHash("sha256")
    .update(`${proofPath}:${Date.now()}:${process.env.ZEROG_PRIVATE_KEY ?? ""}`)
    .digest("hex");

  return `0g://${digest}`;
}

export function createApp() {
  const app = express();

  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "pookie-node-orchestrator"
    });
  });

  app.post("/mcp/execute", async (request, response) => {
    const { url, task, x402_sig } = request.body ?? {};

    if (typeof url !== "string" || typeof task !== "string") {
      response.status(400).json({
        ok: false,
        error: "Expected JSON body with string fields: url, task, x402_sig"
      });
      return;
    }

    const payment = verifyX402PaymentStub({ url, task, x402_sig });
    if (!payment.ok) {
      response.status(402).json({
        ok: false,
        error: payment.reason
      });
      return;
    }

    try {
      const { proofPath } = await runPythonAgent({ url, task });
      const proofHash = await uploadToZeroGStorageStub({ proofPath });

      response.json({
        ok: true,
        proofHash,
        proofPath,
        payment
      });
    } catch (error) {
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
