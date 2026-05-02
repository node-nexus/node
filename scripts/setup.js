import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const axlDir = path.join(projectRoot, "bin", "axl-core");
const axlBinary = path.join(axlDir, "axl-client");
const pythonAgentDir = path.join(projectRoot, "python-agent");
const venvDir = path.join(pythonAgentDir, "venv");
const requirementsPath = path.join(pythonAgentDir, "requirements.txt");

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows"
};

const archMap = {
  arm64: "arm64",
  x64: "amd64"
};

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function run(command, options = {}) {
  execSync(command, {
    cwd: projectRoot,
    stdio: "inherit",
    ...options
  });
}

function shouldRequireRealAxl() {
  return process.env.REQUIRE_REAL_AXL === "true";
}

function resolveAxlDownloadUrl() {
  const platform = platformMap[process.platform];
  const arch = archMap[process.arch] ?? process.arch;

  if (!platform) {
    throw new Error(`Unsupported platform for AXL binary download: ${process.platform}`);
  }

  const baseUrl =
    process.env.AXL_RELEASE_BASE_URL ??
    "https://github.com/gensyn-ai/axl/releases/latest/download";
  const extension = process.platform === "win32" ? ".exe" : "";

  return `${baseUrl}/axl-client-${platform}-${arch}${extension}`;
}

function createAxlShim(downloadUrl) {
  const shim = `#!/usr/bin/env bash
set -euo pipefail

echo "[pookie axl shim] Real Gensyn AXL binary was not available during setup."
echo "[pookie axl shim] Original download URL: ${downloadUrl}"
echo "[pookie axl shim] Args: $*"
echo "[pookie axl shim] Mock mesh online. Forward target should be http://localhost:8080/mcp/execute"

trap 'echo "[pookie axl shim] shutting down"; exit 0' INT TERM

while true; do
  echo "[pookie axl shim] heartbeat: waiting for mesh tasks"
  sleep 30
done
`;

  writeFileSync(axlBinary, shim, { mode: 0o755 });
  run(`chmod +x ${shellQuote(axlBinary)}`);
}

function installAxl() {
  mkdirSync(axlDir, { recursive: true });
  const downloadUrl = resolveAxlDownloadUrl();

  console.log(`Downloading Gensyn AXL binary from ${downloadUrl}`);

  try {
    run(`curl -fL ${shellQuote(downloadUrl)} -o ${shellQuote(axlBinary)}`);
    run(`chmod +x ${shellQuote(axlBinary)}`);
  } catch (error) {
    if (existsSync(axlBinary)) {
      unlinkSync(axlBinary);
    }

    if (shouldRequireRealAxl()) {
      throw new Error(
        [
          "Failed to download the Gensyn AXL binary.",
          `Tried: ${downloadUrl}`,
          "If no release binary exists yet, download/build AXL manually and place it at bin/axl-core/axl-client,",
          "or rerun with AXL_RELEASE_BASE_URL pointing at a release that contains axl-client-{platform}-{arch}."
        ].join("\n")
      );
    }

    console.warn("Failed to download the Gensyn AXL binary; creating a local hackathon shim instead.");
    console.warn(`Tried: ${downloadUrl}`);
    console.warn("Set REQUIRE_REAL_AXL=true to fail setup instead of using the shim.");
    createAxlShim(downloadUrl);
  }
}

function installPythonAgent() {
  mkdirSync(pythonAgentDir, { recursive: true });

  if (!existsSync(venvDir)) {
    console.log("Creating Python virtual environment at python-agent/venv");
    run(`python3 -m venv ${shellQuote(venvDir)}`);
  } else {
    console.log("Python virtual environment already exists; reusing python-agent/venv");
  }

  writeFileSync(
    requirementsPath,
    ["browser-use", "langchain-openai", "python-dotenv", "playwright", "reportlab", ""].join("\n")
  );

  const venvPython =
    process.platform === "win32"
      ? path.join(venvDir, "Scripts", "python.exe")
      : path.join(venvDir, "bin", "python3");

  console.log("Installing Python browser agent dependencies");
  run(`${shellQuote(venvPython)} -m pip install --upgrade pip`);
  run(`${shellQuote(venvPython)} -m pip install -r ${shellQuote(requirementsPath)}`);

  console.log("Installing Playwright Chromium browser");
  run(`${shellQuote(venvPython)} -m playwright install chromium`);
}

function main() {
  console.log(`Detected platform=${process.platform}, arch=${process.arch}`);
  installAxl();
  installPythonAgent();
  console.log("Pookie Node setup complete.");
}

main();
