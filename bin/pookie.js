#!/usr/bin/env node

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { AxlProcess } from "../src/axlProcess.js";
import { loadNodeProfile } from "../src/nodeProfile.js";
import { writeNodeMetadata } from "../src/nodeMetadata.js";
import { startServer } from "../src/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });

const venvPython =
  process.platform === "win32"
    ? path.join(projectRoot, "python-agent", "venv", "Scripts", "python.exe")
    : path.join(projectRoot, "python-agent", "venv", "bin", "python3");

function exitWithSetupHint(message) {
  console.error(`Node Nexus cannot start: ${message}`);
  console.error("Run npm run setup if the Python agent is missing, then configure .env.");
  process.exit(1);
}

function assertReady() {
  if (!existsSync(venvPython)) {
    exitWithSetupHint(`Python virtual environment not found at ${venvPython}`);
  }
}

function main() {
  assertReady();

  const { profile, source } = loadNodeProfile();
  console.log(`[node-profile] loaded ${profile.nodeId} from ${source}`);

  const { metadataPath, relativePath } = writeNodeMetadata({ profile });
  console.log(`[node-metadata] wrote ${relativePath}`);

  const axl = new AxlProcess({ metadataPath });
  const server = startServer({
    nodeProfile: profile,
    axlStatusProvider: () => axl.status()
  });

  const shutdown = (signal) => {
    console.log(`Received ${signal}; shutting down Node Nexus.`);
    axl.stop(signal);
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    axl.start({
      onFatal: (error) => {
        console.error(`[axl] fatal: ${error.message}`);
        server.close(() => process.exit(1));
      }
    });
  } catch (error) {
    server.close(() => {
      exitWithSetupHint(error instanceof Error ? error.message : String(error));
    });
  }
}

main();
