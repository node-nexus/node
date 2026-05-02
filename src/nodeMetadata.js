import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nodeLocation } from "./nodeProfile.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function resolveMetadataPath(env = process.env) {
  const configuredPath = env.AXL_METADATA_PATH?.trim();
  if (configuredPath) {
    return path.isAbsolute(configuredPath)
      ? configuredPath
      : path.resolve(projectRoot, configuredPath);
  }

  return path.join(projectRoot, "artifacts", "node-metadata.json");
}

export function buildNodeMetadata({ profile, env = process.env }) {
  return {
    protocol: "node-nexus-webops",
    version: "0.1.0",
    nodeId: profile.nodeId,
    displayName: profile.displayName ?? profile.nodeId,
    location: nodeLocation(profile),
    capabilities: profile.capabilities,
    mcpForwardUrl: env.AXL_MCP_FORWARD_URL ?? `http://localhost:${env.PORT ?? 8080}/mcp/execute`,
    taskSchemas: ["webops.browser.report.v1"],
    reportFormats: ["pdf", "json"],
    storage: ["0g"]
  };
}

export function writeNodeMetadata({ profile, env = process.env }) {
  const metadataPath = resolveMetadataPath(env);
  const metadata = buildNodeMetadata({ profile, env });

  mkdirSync(path.dirname(metadataPath), { recursive: true });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  return {
    metadata,
    metadataPath,
    relativePath: path.relative(projectRoot, metadataPath)
  };
}
