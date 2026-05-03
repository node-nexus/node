import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

function json(value, fallback = null) {
  if (value === undefined) {
    return JSON.stringify(fallback);
  }
  return JSON.stringify(value);
}

function parse(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function now() {
  return new Date().toISOString();
}

export class GatewayStore {
  constructor({ dbPath = process.env.GATEWAY_DB_PATH || "data/node-nexus-gateway.sqlite" } = {}) {
    const absolutePath = path.isAbsolute(dbPath) ? dbPath : path.resolve(projectRoot, dbPath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    this.dbPath = absolutePath;
    this.db = new DatabaseSync(absolutePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_tasks (
        task_id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        task TEXT NOT NULL,
        report_type TEXT NOT NULL,
        target_nodes TEXT NOT NULL,
        target_locations TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        peer_id TEXT,
        node_id TEXT,
        location_json TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        final_url TEXT,
        report_uri TEXT,
        report_path TEXT,
        metadata_path TEXT,
        response_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP TABLE IF EXISTS known_nodes;
    `);
  }

  createTask({ taskId, url, task, reportType, targetNodes, targetLocations, request }) {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO gateway_tasks (
          task_id, url, task, report_type, target_nodes, target_locations,
          status, request_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        url,
        task,
        reportType,
        json(targetNodes, []),
        json(targetLocations, []),
        "queued",
        json(request, {}),
        timestamp,
        timestamp
      );
    return this.getTask(taskId);
  }

  setTaskStatus(taskId, status) {
    this.db
      .prepare("UPDATE gateway_tasks SET status = ?, updated_at = ? WHERE task_id = ?")
      .run(status, now(), taskId);
  }

  addReport({
    taskId,
    peerId = null,
    nodeId = null,
    location = null,
    status,
    summary = "",
    finalUrl = null,
    reportUri = null,
    reportPath = null,
    metadataPath = null,
    response = null,
    error = null
  }) {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO gateway_reports (
          task_id, peer_id, node_id, location_json, status, summary, final_url,
          report_uri, report_path, metadata_path, response_json, error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        peerId,
        nodeId,
        json(location),
        status,
        summary,
        finalUrl,
        reportUri,
        reportPath,
        metadataPath,
        json(response),
        error,
        timestamp,
        timestamp
      );
  }

  listTasks({ limit = 50 } = {}) {
    return this.db
      .prepare("SELECT * FROM gateway_tasks ORDER BY created_at DESC LIMIT ?")
      .all(limit)
      .map((row) => this.formatTask(row));
  }

  getTask(taskId) {
    const row = this.db.prepare("SELECT * FROM gateway_tasks WHERE task_id = ?").get(taskId);
    return row ? this.formatTask(row) : null;
  }

  listReports(taskId) {
    return this.db
      .prepare("SELECT * FROM gateway_reports WHERE task_id = ? ORDER BY created_at ASC")
      .all(taskId)
      .map(formatReport);
  }

  formatTask(row) {
    const task = {
      taskId: row.task_id,
      url: row.url,
      task: row.task,
      reportType: row.report_type,
      targetNodes: parse(row.target_nodes, []),
      targetLocations: parse(row.target_locations, []),
      status: row.status,
      request: parse(row.request_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    task.reports = this.listReports(task.taskId);
    return task;
  }
}

function formatReport(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    peerId: row.peer_id,
    nodeId: row.node_id,
    location: parse(row.location_json),
    status: row.status,
    summary: row.summary,
    finalUrl: row.final_url,
    reportUri: row.report_uri,
    reportPath: row.report_path,
    metadataPath: row.metadata_path,
    response: parse(row.response_json),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
