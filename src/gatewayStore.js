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
        payment_intent_json TEXT,
        dispatch_started_at TEXT,
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
      CREATE TABLE IF NOT EXISTS consumed_payment_txs (
        tx_hash TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        payment_intent_id TEXT NOT NULL,
        consumed_at TEXT NOT NULL
      );
      DROP TABLE IF EXISTS known_nodes;
    `);
    this.migrate();
  }

  migrate() {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(gateway_tasks)").all().map((column) => column.name)
    );

    if (!columns.has("payment_intent_json")) {
      this.db.exec("ALTER TABLE gateway_tasks ADD COLUMN payment_intent_json TEXT");
    }

    if (!columns.has("dispatch_started_at")) {
      this.db.exec("ALTER TABLE gateway_tasks ADD COLUMN dispatch_started_at TEXT");
    }
  }

  createTask({
    taskId,
    url,
    task,
    reportType,
    targetNodes,
    targetLocations,
    request,
    status = "payment_required",
    paymentIntent = null
  }) {
    const timestamp = now();
    this.db
      .prepare(
        `INSERT INTO gateway_tasks (
          task_id, url, task, report_type, target_nodes, target_locations,
          status, request_json, payment_intent_json, dispatch_started_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        url,
        task,
        reportType,
        json(targetNodes, []),
        json(targetLocations, []),
        status,
        json(request, {}),
        json(paymentIntent),
        null,
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

  updateTaskPaymentIntent(taskId, paymentIntent) {
    this.db
      .prepare("UPDATE gateway_tasks SET payment_intent_json = ?, updated_at = ? WHERE task_id = ?")
      .run(json(paymentIntent), now(), taskId);
  }

  updateTask({
    taskId,
    status,
    paymentIntent,
    dispatchStartedAt
  }) {
    const current = this.getTask(taskId);
    if (!current) {
      return null;
    }

    this.db
      .prepare(
        `UPDATE gateway_tasks
         SET status = ?, payment_intent_json = ?, dispatch_started_at = ?, updated_at = ?
         WHERE task_id = ?`
      )
      .run(
        status ?? current.status,
        json(paymentIntent ?? current.paymentIntent),
        dispatchStartedAt ?? current.dispatchStartedAt ?? null,
        now(),
        taskId
      );

    return this.getTask(taskId);
  }

  claimTaskForDispatch(taskId) {
    const claimedAt = now();
    const result = this.db
      .prepare(
        `UPDATE gateway_tasks
         SET dispatch_started_at = ?, updated_at = ?
         WHERE task_id = ? AND status = 'queued' AND dispatch_started_at IS NULL`
      )
      .run(claimedAt, claimedAt, taskId);

    return result.changes > 0;
  }

  getConsumedPaymentTx(txHash) {
    return (
      this.db
        .prepare("SELECT * FROM consumed_payment_txs WHERE tx_hash = ?")
        .get(String(txHash ?? "").toLowerCase()) ?? null
    );
  }

  consumePaymentTx({ txHash, taskId, paymentIntentId }) {
    this.db
      .prepare(
        `INSERT INTO consumed_payment_txs (tx_hash, task_id, payment_intent_id, consumed_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(String(txHash ?? "").toLowerCase(), taskId, paymentIntentId, now());
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
      paymentIntent: parse(row.payment_intent_json),
      dispatchStartedAt: row.dispatch_started_at,
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
