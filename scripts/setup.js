import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(projectRoot, ".env") });

const axlDir = path.join(projectRoot, "bin", "axl-core");
const axlBinary = path.join(axlDir, "axl-client");
const axlNodeBinary = path.join(axlDir, "node");
const axlConfigPath = path.join(axlDir, "node-config.json");
const axlPrivateKeyPath = path.join(axlDir, "private.pem");
const axlSourceDir = path.join(projectRoot, "vendor", "axl");
const pythonAgentDir = path.join(projectRoot, "python-agent");
const venvDir = path.join(pythonAgentDir, "venv");
const requirementsPath = path.join(pythonAgentDir, "requirements.txt");
const webDir = path.join(projectRoot, "web");

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

function commandExists(command) {
  try {
    execSync(`command -v ${shellQuote(command)}`, {
      cwd: projectRoot,
      stdio: "ignore",
      shell: "/bin/sh"
    });
    return true;
  } catch {
    return false;
  }
}

function shouldRequireRealAxl() {
  return process.env.REQUIRE_REAL_AXL === "true";
}

function isMockShim(binaryPath) {
  if (!existsSync(binaryPath)) {
    return false;
  }

  try {
    return readFileSync(binaryPath, "utf8").includes("node nexus axl shim");
  } catch {
    return false;
  }
}

function binaryLooksCompatible(binaryPath) {
  if (!existsSync(binaryPath)) {
    return false;
  }

  if (!commandExists("file")) {
    return true;
  }

  try {
    const description = execSync(`file ${shellQuote(binaryPath)}`, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: "/bin/sh"
    });

    if (process.platform === "linux") {
      return description.includes("ELF");
    }

    if (process.platform === "darwin") {
      const archMatches =
        process.arch === "arm64" ? description.includes("arm64") : description.includes("x86_64");
      return description.includes("Mach-O") && archMatches;
    }

    return true;
  } catch {
    return true;
  }
}

function isRealAxlBinary(binaryPath) {
  return existsSync(binaryPath) && !isMockShim(binaryPath) && binaryLooksCompatible(binaryPath);
}

function parseMcpForwardUrl() {
  const fallback = "http://127.0.0.1:8080/mcp/execute";
  const value = process.env.AXL_MCP_FORWARD_URL || `http://127.0.0.1:${process.env.PORT ?? 8080}/mcp/execute`;
  const parsed = new URL(value || fallback);
  return {
    routerAddr: `${parsed.protocol}//${parsed.hostname}`,
    routerPort: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
  };
}

function writeAxlConfig() {
  const { routerAddr, routerPort } = parseMcpForwardUrl();
  const peers = String(process.env.AXL_PEERS ?? "")
    .split(",")
    .map((peer) => peer.trim())
    .filter(Boolean);
  const listen = String(process.env.AXL_LISTEN ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const config = {
    PrivateKeyPath: axlPrivateKeyPath,
    Peers: peers,
    Listen: listen,
    router_addr: routerAddr,
    router_port: routerPort
  };

  if (process.env.AXL_API_PORT) {
    config.api_port = Number(process.env.AXL_API_PORT);
  }

  if (process.env.AXL_TCP_PORT) {
    config.tcp_port = Number(process.env.AXL_TCP_PORT);
  }

  writeFileSync(axlConfigPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Wrote AXL config to ${path.relative(projectRoot, axlConfigPath)}`);
}

function ensureAxlPrivateKey() {
  if (existsSync(axlPrivateKeyPath)) {
    console.log("AXL private key already exists; reusing bin/axl-core/private.pem");
    return;
  }

  if (!commandExists("openssl")) {
    throw new Error("openssl is required to generate the AXL ed25519 private key.");
  }

  console.log("Generating AXL ed25519 private key at bin/axl-core/private.pem");
  run(`openssl genpkey -algorithm ed25519 -out ${shellQuote(axlPrivateKeyPath)}`);
}

function createAxlShim(reason) {
  const shim = `#!/usr/bin/env bash
set -euo pipefail

echo "[node nexus axl shim] Real Gensyn AXL binary was not available during setup."
echo "[node nexus axl shim] Reason: ${reason}"
echo "[node nexus axl shim] Args: $*"
echo "[node nexus axl shim] AXL mock mode online. Forward target should be http://localhost:8080/mcp/execute"

trap 'echo "[node nexus axl shim] shutting down"; exit 0' INT TERM

while true; do
  echo "[node nexus axl shim] heartbeat: waiting for mesh tasks"
  sleep 30
done
`;

  writeFileSync(axlBinary, shim, { mode: 0o755 });
  run(`chmod +x ${shellQuote(axlBinary)}`);
}

function installAxl() {
  mkdirSync(axlDir, { recursive: true });

  const configuredBinary = process.env.AXL_BINARY_PATH;
  if (configuredBinary && isRealAxlBinary(path.resolve(projectRoot, configuredBinary))) {
    console.log(`AXL binary already configured at ${configuredBinary}; skipping build.`);
    ensureAxlPrivateKey();
    writeAxlConfig();
    return;
  }

  if (isRealAxlBinary(axlNodeBinary)) {
    console.log("Real AXL node binary already exists at bin/axl-core/node; skipping build.");
    ensureAxlPrivateKey();
    writeAxlConfig();
    return;
  }

  if (process.env.SKIP_AXL_BUILD === "true") {
    const reason = "SKIP_AXL_BUILD=true";
    if (shouldRequireRealAxl()) {
      throw new Error(`Real AXL required but ${reason}.`);
    }
    console.warn(`${reason}; creating AXL mock shim.`);
    createAxlShim(reason);
    return;
  }

  try {
    if (!commandExists("git")) {
      throw new Error("git is required to clone gensyn-ai/axl.");
    }
    if (!commandExists("go")) {
      throw new Error("Go 1.25.5+ is required to build gensyn-ai/axl.");
    }

    mkdirSync(path.dirname(axlSourceDir), { recursive: true });
    if (!existsSync(axlSourceDir)) {
      console.log("Cloning Gensyn AXL from https://github.com/gensyn-ai/axl");
      run(`git clone --depth 1 https://github.com/gensyn-ai/axl ${shellQuote(axlSourceDir)}`);
    } else {
      console.log("AXL source already exists at vendor/axl; refreshing main branch.");
      run("git fetch --depth 1 origin main", { cwd: axlSourceDir });
      run("git checkout -f FETCH_HEAD", { cwd: axlSourceDir });
    }

    console.log("Building Gensyn AXL node with Go toolchain pinned by upstream AXL");
    run(`GOTOOLCHAIN=go1.25.5 go build -o ${shellQuote(axlNodeBinary)} ./cmd/node`, {
      cwd: axlSourceDir
    });
    run(`chmod +x ${shellQuote(axlNodeBinary)}`);
    ensureAxlPrivateKey();
    writeAxlConfig();
  } catch (error) {
    if (existsSync(axlNodeBinary)) {
      rmSync(axlNodeBinary, { force: true });
    }

    if (shouldRequireRealAxl()) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Failed to build real Gensyn AXL; creating AXL mock shim. Reason: ${reason}`);
    console.warn("Set REQUIRE_REAL_AXL=true to fail setup instead of using the shim.");
    createAxlShim(reason);
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

function installWebApp() {
  if (!existsSync(path.join(webDir, "package.json"))) {
    return;
  }

  console.log("Installing Node Nexus web console dependencies");
  run("npm install", { cwd: webDir });
}

function main() {
  console.log(`Detected platform=${process.platform}, arch=${process.arch}`);
  installAxl();
  installPythonAgent();
  installWebApp();
  console.log("Node Nexus setup complete.");
}

main();
