import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const DEFAULT_AXL_NODE_BINARY = path.join(projectRoot, "bin", "axl-core", "node");
const DEFAULT_AXL_SHIM_BINARY = path.join(projectRoot, "bin", "axl-core", "axl-client");
const DEFAULT_AXL_CONFIG = path.join(projectRoot, "bin", "axl-core", "node-config.json");

function normalizeMode(value) {
  const mode = String(value ?? "disabled").trim().toLowerCase();
  if (["real", "mock", "disabled"].includes(mode)) {
    return mode;
  }

  throw new Error(`Invalid AXL_MODE=${value}. Expected real, mock, or disabled.`);
}

function resolveAxlBinary(env, mode) {
  const configured = env.AXL_BINARY_PATH?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
  }

  if (mode === "real" && existsSync(DEFAULT_AXL_NODE_BINARY)) {
    return DEFAULT_AXL_NODE_BINARY;
  }

  return existsSync(DEFAULT_AXL_NODE_BINARY) ? DEFAULT_AXL_NODE_BINARY : DEFAULT_AXL_SHIM_BINARY;
}

function resolveAxlConfig(env) {
  const configured = env.AXL_CONFIG_PATH?.trim();
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(projectRoot, configured);
  }

  return DEFAULT_AXL_CONFIG;
}

function pipeWithPrefix(stream, prefix, output) {
  stream?.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line) {
        output.write(`[${prefix}] ${line}\n`);
      }
    }
  });
}

export class AxlProcess {
  constructor({ env = process.env, metadataPath = null } = {}) {
    this.env = env;
    this.mode = normalizeMode(env.AXL_MODE);
    this.metadataPath = metadataPath;
    this.child = null;
    this.running = false;
    this.lastExit = null;
    this.lastError = null;
    this.network = env.AXL_NETWORK ?? "testnet";
    this.identity = env.AXL_IDENTITY ?? "";
    this.mcpForwardUrl = env.AXL_MCP_FORWARD_URL ?? `http://localhost:${env.PORT ?? 8080}/mcp/execute`;
    this.configPath = resolveAxlConfig(env);
    this.failFast = String(env.AXL_FAIL_FAST ?? "true").trim().toLowerCase() !== "false";
  }

  start({ onFatal } = {}) {
    if (this.mode === "disabled") {
      console.log("[axl] AXL disabled mode: mesh process not started.");
      return;
    }

    const binaryPath = resolveAxlBinary(this.env, this.mode);
    if (!existsSync(binaryPath)) {
      throw new Error(
        `AXL ${this.mode} mode requested but binary is missing at ${binaryPath}. ` +
          "Set AXL_BINARY_PATH or run npm run setup."
      );
    }

    if (this.mode === "real" && !existsSync(this.configPath)) {
      throw new Error(
        `AXL real mode requested but config is missing at ${this.configPath}. Run npm run setup.`
      );
    }

    const args =
      this.mode === "real"
        ? ["-config", this.configPath]
        : [
            "--network",
            this.network,
            "--identity",
            this.identity || "node-nexus-mock",
            "--mcp-forward",
            this.mcpForwardUrl
          ];

    if (this.mode === "mock" && this.metadataPath) {
      args.push("--metadata", this.metadataPath);
    }

    console.log(
      this.mode === "mock"
        ? `[axl] AXL mock mode starting ${binaryPath}`
        : `[axl] AXL real mode starting ${binaryPath}`
    );

    this.child = spawn(binaryPath, args, {
      cwd: projectRoot,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.running = true;

    pipeWithPrefix(this.child.stdout, "axl", process.stdout);
    pipeWithPrefix(this.child.stderr, "axl", process.stderr);

    this.child.on("error", (error) => {
      this.lastError = error.message;
      this.running = false;
      console.error(`[axl] Failed to start: ${error.message}`);
      if (this.mode === "real" && this.failFast && onFatal) {
        onFatal(error);
      }
    });

    this.child.on("exit", (code, signal) => {
      this.running = false;
      this.lastExit = { code, signal, at: new Date().toISOString() };
      console.log(signal ? `[axl] exited from signal ${signal}` : `[axl] exited with code ${code}`);

      if (this.mode === "real" && this.failFast && code !== 0 && onFatal) {
        onFatal(new Error(`AXL exited unexpectedly with code ${code}`));
      }
    });
  }

  stop(signal = "SIGTERM") {
    if (this.child && this.running) {
      this.child.kill(signal);
    }
  }

  status() {
    return {
      mode: this.mode,
      running: this.running,
      pid: this.child?.pid ?? null,
      network: this.network,
      identity: this.identity,
      mcpForwardUrl: this.mcpForwardUrl,
      configPath: this.configPath,
      metadataPath: this.metadataPath,
      failFast: this.failFast,
      lastExit: this.lastExit,
      lastError: this.lastError
    };
  }
}
