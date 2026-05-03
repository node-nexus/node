"use client";

import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Database,
  Globe2,
  Loader2,
  RadioTower,
  RefreshCcw,
  Route,
  Send,
  Server,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const DEFAULT_API_PORT = process.env.NEXT_PUBLIC_NODE_NEXUS_API_PORT || "8080";
const ZERO_G_INDEXER_BASE =
  process.env.NEXT_PUBLIC_ZERO_G_INDEXER_BASE || "https://indexer-storage-testnet-turbo.0g.ai";

function apiBaseUrl() {
  const configured = process.env.NEXT_PUBLIC_NODE_NEXUS_API_URL;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  if (typeof window !== "undefined") {
    const protocol = window.location.protocol === "https:" ? "https" : "http";
    return `${protocol}://${window.location.hostname}:${DEFAULT_API_PORT}`;
  }

  return `http://localhost:${DEFAULT_API_PORT}`;
}

function apiBaseCandidates() {
  const configured = process.env.NEXT_PUBLIC_NODE_NEXUS_API_URL;
  if (configured) {
    return [configured.replace(/\/+$/, "")];
  }
  if (typeof window === "undefined") {
    return [`http://localhost:${DEFAULT_API_PORT}`];
  }
  const host = window.location.hostname;
  const primaryProtocol = window.location.protocol === "https:" ? "https" : "http";
  return [...new Set([`${primaryProtocol}://${host}:${DEFAULT_API_PORT}`, `http://${host}:${DEFAULT_API_PORT}`])];
}

async function api(path, options = {}) {
  const candidates = apiBaseCandidates();
  let lastNetworkError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const baseUrl = candidates[index];
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        },
        cache: "no-store"
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      return body;
    } catch (error) {
      const isLast = index === candidates.length - 1;
      if (isLast) {
        throw error;
      }
      lastNetworkError = error;
    }
  }

  throw lastNetworkError || new Error("Failed to reach Node Nexus API.");
}

function label(value, fallback = "Not set") {
  return value === null || value === undefined || value === "" ? fallback : value;
}

function toHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const url = value.trim();
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return null;
}

function parseZeroGRoot(value) {
  if (typeof value !== "string") {
    return null;
  }
  const input = value.trim();
  if (!input) {
    return null;
  }
  if (input.startsWith("0g://")) {
    return input.slice("0g://".length);
  }
  if (input.startsWith("0g:/")) {
    return input.slice("0g:/".length);
  }
  return null;
}

function buildIndexerDownloadUrl(rootHash, fileName = "report.pdf") {
  if (!rootHash) {
    return null;
  }
  const normalizedBase = ZERO_G_INDEXER_BASE.replace(/\/+$/, "");
  return `${normalizedBase}/file?root=${encodeURIComponent(rootHash)}&name=${encodeURIComponent(fileName)}`;
}

function localArtifactUrl(path) {
  if (typeof path !== "string" || !path.trim()) {
    return null;
  }
  const normalizedPath = path.trim().replace(/^\/+/, "");
  const normalizedApi = apiBaseUrl();
  return `${normalizedApi}/${normalizedPath}`;
}

function resolveReportLinks(report) {
  const zeroGDownloadUrl =
    toHttpUrl(report?.zeroGReportDownloadUrl) ||
    toHttpUrl(report?.zeroG?.reportDownloadUrl) ||
    toHttpUrl(report?.reportLinks?.zeroGDownloadUrl) ||
    buildIndexerDownloadUrl(parseZeroGRoot(report?.reportUri));

  const localDownloadUrl =
    toHttpUrl(report?.reportDownloadUrl) ||
    toHttpUrl(report?.reportLinks?.localDownloadUrl) ||
    localArtifactUrl(report?.reportPath);

  return { zeroGDownloadUrl, localDownloadUrl };
}

function StatusIcon({ status }) {
  if (["completed", "mock-dispatched"].includes(status)) {
    return <CheckCircle2 size={16} />;
  }
  if (["failed", "partial"].includes(status)) {
    return <AlertCircle size={16} />;
  }
  return <Loader2 className="spin" size={16} />;
}

export default function Page() {
  const [health, setHealth] = useState(null);
  const [peers, setPeers] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedTask, setSelectedTask] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskForm, setTaskForm] = useState({
    url: "https://example.com",
    task: "Check local UX and produce a report.",
    targetNodes: "",
    targetLocations: "",
    reportType: "webops-local-ux",
    selectionMode: "auto",
    maxTargets: 1
  });

  const refresh = useCallback(async () => {
    setError("");
    const [healthResult, peersResult, tasksResult] = await Promise.all([
      api("/health"),
      api("/gateway/peers"),
      api("/gateway/tasks")
    ]);
    setHealth(healthResult);
    setPeers(peersResult.nodes || []);
    setTasks(tasksResult.tasks || []);
    if (selectedTaskId) {
      const detail = await api(`/gateway/tasks/${selectedTaskId}`);
      setSelectedTask(detail.task);
    } else if (tasksResult.tasks?.[0]) {
      setSelectedTaskId(tasksResult.tasks[0].taskId);
      setSelectedTask(tasksResult.tasks[0]);
    }
  }, [selectedTaskId]);

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    const timer = setInterval(() => refresh().catch(() => {}), 6000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function submitTask(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const targetNodes = taskForm.targetNodes
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
      const targetLocations = taskForm.targetLocations
        .split(/[\n,]/)
        .map((value) => value.trim())
        .filter(Boolean);
      const result = await api("/gateway/tasks", {
        method: "POST",
        body: JSON.stringify({
          url: taskForm.url,
          task: taskForm.task,
          targetNodes,
          targetLocations,
          reportType: taskForm.reportType,
          selectionMode: taskForm.selectionMode,
          maxTargets: Number(taskForm.maxTargets || 1)
        })
      });
      setSelectedTaskId(result.taskId);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function chooseTask(taskId) {
    setSelectedTaskId(taskId);
    const detail = await api(`/gateway/tasks/${taskId}`);
    setSelectedTask(detail.task);
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Gateway Console</p>
          <h1>Node Nexus</h1>
        </div>
        <nav className="navActions">
          <Link href="/peers">Live peers</Link>
          <button className="iconButton" onClick={() => refresh()} title="Refresh">
            <RefreshCcw size={18} />
          </button>
        </nav>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="statusGrid">
        <StatusTile icon={<Server />} label="Service" value={health?.service} />
        <StatusTile icon={<RadioTower />} label="AXL" value={`${label(health?.axl?.mode)} / ${health?.axl?.running ? "running" : "stopped"}`} />
        <StatusTile icon={<ShieldCheck />} label="0G" value={`${label(health?.zeroG?.uploadMode)} / ${health?.zeroG?.configured ? "configured" : "missing"}`} />
        <StatusTile icon={<Database />} label="Qwen selector" value={health?.qwenSelection?.configured ? "configured" : "fallback auto"} />
      </section>

      <section className="workspace">
        <form className="panel submitPanel" onSubmit={submitTask}>
          <div className="panelHeader">
            <div>
              <h2>Dispatch Task</h2>
              <p>Leave peer IDs blank to route from fresh AXL discovery.</p>
            </div>
            <button disabled={busy} type="submit">
              <Send size={16} />
              Submit
            </button>
          </div>
          <label>
            URL
            <input value={taskForm.url} onChange={(event) => setTaskForm({ ...taskForm, url: event.target.value })} />
          </label>
          <label>
            Task
            <textarea rows={4} value={taskForm.task} onChange={(event) => setTaskForm({ ...taskForm, task: event.target.value })} />
          </label>
          <label>
            Optional explicit peer IDs
            <textarea
              rows={3}
              placeholder="Blank = auto-select from live AXL peers"
              value={taskForm.targetNodes}
              onChange={(event) => setTaskForm({ ...taskForm, targetNodes: event.target.value })}
            />
          </label>
          <div className="threeCol">
            <label>
              Locations
              <input value={taskForm.targetLocations} onChange={(event) => setTaskForm({ ...taskForm, targetLocations: event.target.value })} placeholder="IN, US, Mumbai" />
            </label>
            <label>
              Routing
              <select value={taskForm.selectionMode} onChange={(event) => setTaskForm({ ...taskForm, selectionMode: event.target.value })}>
                <option value="auto">Auto</option>
                <option value="ai">Qwen via 0G</option>
              </select>
            </label>
            <label>
              Targets
              <input type="number" min="1" max="12" value={taskForm.maxTargets} onChange={(event) => setTaskForm({ ...taskForm, maxTargets: event.target.value })} />
            </label>
          </div>
          <label>
            Report type
            <input value={taskForm.reportType} onChange={(event) => setTaskForm({ ...taskForm, reportType: event.target.value })} />
          </label>
        </form>

        <aside className="panel">
          <div className="panelHeader">
            <div>
              <h2>Live Discovery</h2>
              <p>Fresh profile probes only. No node registry is kept.</p>
            </div>
            <Globe2 size={18} />
          </div>
          <div className="nodeList">
            {peers.slice(0, 8).map((node) => (
              <button key={node.peerId} type="button" onClick={() => setTaskForm({ ...taskForm, targetNodes: node.peerId })}>
                {node.profileStatus === "available" || node.profileStatus === "mock" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                <span>{node.displayName || node.nodeId || node.peerId.slice(0, 12)}</span>
                <small>{node.location?.country || node.profileStatus}</small>
              </button>
            ))}
            {!peers.length ? <p className="muted">No live peers found yet.</p> : null}
          </div>
          <Link className="textLink" href="/peers">
            Inspect live peer scan
          </Link>
        </aside>
      </section>

      <section className="reports">
        <div className="taskList panel">
          <div className="panelHeader">
            <div>
              <h2>Tasks</h2>
              <p>Recent gateway dispatches.</p>
            </div>
            <Activity size={18} />
          </div>
          {tasks.map((taskItem) => (
            <button
              key={taskItem.taskId}
              className={selectedTaskId === taskItem.taskId ? "selectedTask" : ""}
              onClick={() => chooseTask(taskItem.taskId).catch((err) => setError(err.message))}
              type="button"
            >
              <StatusIcon status={taskItem.status} />
              <span>{taskItem.taskId.slice(0, 18)}</span>
              <small>{taskItem.status}</small>
            </button>
          ))}
          {!tasks.length ? <p className="muted">No tasks submitted yet.</p> : null}
        </div>

        <div className="panel detail">
          <div className="panelHeader">
            <div>
              <h2>Reports</h2>
              <p>{selectedTask ? selectedTask.taskId : "Select a task"}</p>
            </div>
            <Route size={18} />
          </div>
          {selectedTask ? (
            <>
              <div className="taskMeta">
                <span>{selectedTask.status}</span>
                <span>{selectedTask.url}</span>
                <span>{selectedTask.targetNodes.length} selected peer(s)</span>
                <span>{selectedTask.request?.selection?.mode || "manual"}</span>
              </div>
              <p className="taskText">{selectedTask.task}</p>
              {selectedTask.request?.selection?.rationale ? (
                <p className="selectionNote">
                  <Sparkles size={14} />
                  {selectedTask.request.selection.rationale}
                </p>
              ) : null}
              <div className="reportList">
                {selectedTask.reports.map((report) => (
                  <article key={report.id}>
                    {(() => {
                      const links = resolveReportLinks(report);
                      return (
                        <>
                    <div className="reportHead">
                      <StatusIcon status={report.status} />
                      <strong>{report.nodeId || report.peerId || "node"}</strong>
                      <span>{report.location?.country || ""}</span>
                    </div>
                    <p>{report.summary || report.error || "No summary yet."}</p>
                    <div className="links">
                      {links.zeroGDownloadUrl ? (
                        <a href={links.zeroGDownloadUrl} target="_blank" rel="noopener noreferrer">
                          Download from 0G
                        </a>
                      ) : null}
                      {links.localDownloadUrl ? (
                        <a href={links.localDownloadUrl} target="_blank" rel="noopener noreferrer">
                          Download PDF
                        </a>
                      ) : null}
                      {report.reportUri ? <span>{report.reportUri}</span> : null}
                      {report.reportPath ? <span>{report.reportPath}</span> : null}
                      {report.metadataPath ? <span>{report.metadataPath}</span> : null}
                    </div>
                        </>
                      );
                    })()}
                  </article>
                ))}
                {!selectedTask.reports.length ? <p className="muted">Waiting for reports.</p> : null}
              </div>
            </>
          ) : (
            <p className="muted">Task results will appear here after dispatch.</p>
          )}
        </div>
      </section>
    </main>
  );
}

function StatusTile({ icon, label: tileLabel, value }) {
  return (
    <div className="statusTile">
      {icon}
      <span>{tileLabel}</span>
      <strong>{label(value)}</strong>
    </div>
  );
}
