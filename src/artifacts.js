import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function resolveArtifactPath(artifactPath) {
  return path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(projectRoot, artifactPath);
}

export function applyArtifactRetention({ screenshots }, env = process.env) {
  if (
    String(env.ARTIFACT_RETENTION ?? "keep").trim().toLowerCase() !==
    "delete_screenshots_after_upload"
  ) {
    return;
  }

  for (const screenshot of screenshots ?? []) {
    rmSync(resolveArtifactPath(screenshot), { force: true });
  }
}
