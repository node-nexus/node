#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { startServer } from "../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });

const axlBinary = path.join(projectRoot, "bin", "axl-core", "axl-client");
const venvPython =
  process.platform === "win32"
    ? path.join(projectRoot, "python-agent", "venv", "Scripts", "python.exe")
    : path.join(projectRoot, "python-agent", "venv", "bin", "python3");

function exitWithSetupHint(message) {
  console.error(`Pookie Node cannot start: ${message}`);
  console.error("Run npm run setup, then configure .env before starting the node.");
  process.exit(1);
}

function assertReady() {
  if (!existsSync(venvPython)) {
    exitWithSetupHint(`Python virtual environment not found at ${venvPython}`);
  }

  if (!existsSync(axlBinary)) {
    exitWithSetupHint(`Gensyn AXL binary not found at ${axlBinary}`);
  }

  if (!process.env.ENS_IDENTITY) {
    exitWithSetupHint("ENS_IDENTITY is missing from .env");
  }
}

function pipeWithPrefix(stream, prefix, output) {
  stream.on("data", (chunk) => {
    output.write(`[${prefix}] ${chunk}`);
  });
}

function main() {
  assertReady();

  const server = startServer();

  // Hackathon mode: use the requested prompt flags. Current public AXL docs
  // emphasize node-config.json with router_addr/router_port, so if this binary
  // rejects these flags, switch to config-mode once the official release shape
  // is known.
  const axl = spawn(
    axlBinary,
    [
      "--network",
      "testnet",
      "--identity",
      process.env.ENS_IDENTITY,
      "--mcp-forward",
      "http://localhost:8080/mcp/execute"
    ],
    {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  pipeWithPrefix(axl.stdout, "axl", process.stdout);
  pipeWithPrefix(axl.stderr, "axl", process.stderr);

  axl.on("error", (error) => {
    console.error(`[axl] Failed to start: ${error.message}`);
    server.close(() => process.exit(1));
  });

  axl.on("exit", (code, signal) => {
    if (signal) {
      console.log(`[axl] exited from signal ${signal}`);
    } else {
      console.log(`[axl] exited with code ${code}`);
    }

    server.close(() => {
      process.exitCode = code ?? 0;
    });
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down Pookie Node.`);
    axl.kill(signal);
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main();
