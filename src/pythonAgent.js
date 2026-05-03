import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logStep, truncate } from "./logging.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const agentPath = path.join(projectRoot, "python-agent", "agent.py");
const venvPython =
  process.platform === "win32"
    ? path.join(projectRoot, "python-agent", "venv", "Scripts", "python.exe")
    : path.join(projectRoot, "python-agent", "venv", "bin", "python3");

function parseInfoValue(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  if (
    trimmed.startsWith("[") ||
    trimmed.startsWith("{") ||
    trimmed === "true" ||
    trimmed === "false" ||
    trimmed === "null"
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

export function parsePythonInfo(stdout) {
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

        return [
          entry.slice(0, separatorIndex),
          parseInfoValue(entry.slice(separatorIndex + 1))
        ];
      })
  );
}

export function parsePythonError(stdout) {
  return stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("ERROR|"))
    ?.slice("ERROR|".length)
    .trim();
}

function requirePythonAgent(requestId) {
  if (existsSync(venvPython)) {
    return;
  }

  logStep(requestId, "python-agent", "fail", {
    reason: "missing-venv",
    venvPython
  });

  throw new Error(
    `Python virtual environment not found at ${venvPython}. Run npm run setup first.`
  );
}

function writePythonAgentLog({ taskId, stdout, stderr }) {
  const safeTaskId = String(taskId || "manual")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .slice(0, 120) || "manual";
  const artifactDir = path.join(projectRoot, "artifacts", safeTaskId);
  const logPath = path.join(artifactDir, "python-agent.log");

  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    logPath,
    [
      "=== stdout ===",
      stdout.trim(),
      "",
      "=== stderr ===",
      stderr.trim(),
      ""
    ].join("\n"),
    "utf8"
  );

  return path.relative(projectRoot, logPath);
}

export function runPythonAgent({
  url,
  task,
  requestId,
  taskId,
  nodeProfile,
  reportType,
  requestedBy,
  targetLocation
}) {
  return new Promise((resolve, reject) => {
    try {
      requirePythonAgent(requestId);
    } catch (error) {
      reject(error);
      return;
    }

    logStep(requestId, "python-agent", "start", {
      agentPath,
      timeoutMs: 10 * 60 * 1000
    });

    execFile(
      venvPython,
      [
        agentPath,
        url,
        task,
        "--request-id",
        requestId,
        "--task-id",
        taskId,
        "--node-profile-json",
        JSON.stringify(nodeProfile ?? {}),
        "--report-type",
        reportType ?? "webops-local-ux",
        "--requested-by",
        requestedBy ?? "",
        "--target-location",
        targetLocation ?? ""
      ],
      {
        cwd: projectRoot,
        env: process.env,
        timeout: 10 * 60 * 1000,
        maxBuffer: 1024 * 1024 * 10
      },
      (error, stdout, stderr) => {
        const pythonLogPath = writePythonAgentLog({ taskId, stdout, stderr });

        if (error) {
          const pythonError = parsePythonError(stdout);
          const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
          logStep(requestId, "python-agent", "fail", {
            error: truncate(pythonError || details || error.message),
            pythonLogPath,
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
            pythonLogPath,
            stdout: truncate(stdout)
          });
          reject(new Error(`Python agent did not return SUCCESS marker. stdout: ${stdout}`));
          return;
        }

        const reportPath = successLine.slice("SUCCESS|".length).trim();
        const info = parsePythonInfo(stdout);
        const { status: completionStatus, ...logInfo } = info;
        logStep(requestId, "python-agent", "success", {
          reportPath,
          ...logInfo,
          completionStatus,
          pythonLogPath,
          stderr: stderr.trim() ? truncate(stderr.trim()) : undefined
        });

        resolve({
          taskId: info.taskId || taskId,
          reportPath: info.reportPath || reportPath,
          artifactDir: info.artifactDir,
          metadataPath: info.metadataPath,
          screenshots: Array.isArray(info.screenshots) ? info.screenshots : [],
          finalUrl: info.finalUrl,
          status: info.status,
          summary: info.summary,
          pythonLogPath,
          info,
          stdout,
          stderr
        });
      }
    );
  });
}
