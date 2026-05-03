"use client";

import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Coins,
  Loader2,
  RefreshCcw,
  Route,
  Sparkles,
  Wallet
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const DEFAULT_API_PORT = process.env.NEXT_PUBLIC_NODE_NEXUS_API_PORT || "8080";
const ZERO_G_INDEXER_BASE =
  process.env.NEXT_PUBLIC_ZERO_G_INDEXER_BASE || "https://indexer-storage-testnet-turbo.0g.ai";
const ZERO_G_CHAIN_ID = Number(process.env.NEXT_PUBLIC_ZERO_G_CHAIN_ID || 16602);
const ZERO_G_CHAIN_HEX = `0x${ZERO_G_CHAIN_ID.toString(16)}`;
const ZERO_G_CHAIN_NAME = process.env.NEXT_PUBLIC_ZERO_G_CHAIN_NAME || "0G-Testnet-Galileo";
const ZERO_G_RPC_URL = process.env.NEXT_PUBLIC_ZERO_G_RPC_URL || "https://evmrpc-testnet.0g.ai";
const ZERO_G_EXPLORER_URL =
  process.env.NEXT_PUBLIC_ZERO_G_EXPLORER_URL || "https://chainscan-galileo.0g.ai";

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

function resolveReportLinks(report) {
  const response = report?.response;
  const zeroGDownloadUrl =
    toHttpUrl(report?.zeroGReportDownloadUrl) ||
    toHttpUrl(report?.zeroG?.reportDownloadUrl) ||
    toHttpUrl(report?.reportLinks?.zeroGDownloadUrl) ||
    toHttpUrl(report?.reportUri) ||
    toHttpUrl(response?.zeroGReportDownloadUrl) ||
    toHttpUrl(response?.zeroG?.reportDownloadUrl) ||
    toHttpUrl(response?.reportLinks?.zeroGDownloadUrl) ||
    toHttpUrl(response?.reportUri) ||
    buildIndexerDownloadUrl(parseZeroGRoot(report?.reportUri || response?.reportUri));

  return { zeroGDownloadUrl };
}

function visibleReports(reports = []) {
  const latestByPeer = new Map();
  const rank = { accepted: 0, queued: 0, dispatching: 0, running: 1, partial: 2, failed: 2, completed: 3 };

  for (const report of reports) {
    const key =
      report?.nodeId ||
      report?.response?.nodeId ||
      report?.peerId ||
      report?.response?.peerId ||
      report?.id;
    if (!key) {
      continue;
    }
    const previous = latestByPeer.get(key);
    const currentRank = rank[report?.status] ?? 0;
    const previousRank = rank[previous?.status] ?? 0;

    if (!previous || currentRank >= previousRank) {
      latestByPeer.set(key, report);
    }
  }

  return Array.from(latestByPeer.values());
}

function decimalToWeiHex(value) {
  const [wholePart, fractionalPart = ""] = String(value ?? "").trim().split(".");
  const whole = BigInt(wholePart || "0");
  const fraction = BigInt((fractionalPart.replace(/[^\d]/g, "") + "0".repeat(18)).slice(0, 18) || "0");
  const wei = whole * 10n ** 18n + fraction;
  return `0x${wei.toString(16)}`;
}

function shortenAddress(value) {
  if (typeof value !== "string" || value.length < 12) {
    return value || "";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function submittedPaymentsForTask(task, overrides = new Map()) {
  const entries = Array.isArray(task?.paymentIntent?.perNodeAmounts) ? task.paymentIntent.perNodeAmounts : [];
  return entries
    .map((entry) => ({
      peerId: entry.peerId,
      txHash: overrides.get(entry.peerId) ?? entry.txHash ?? null
    }))
    .filter((entry) => entry.txHash);
}

function StatusIcon({ status }) {
  if (["completed", "mock-dispatched", "verified"].includes(status)) {
    return <CheckCircle2 size={16} />;
  }
  if (["failed", "partial"].includes(status)) {
    return <AlertCircle size={16} />;
  }
  return <Loader2 className="spin" size={16} />;
}

export default function Page() {
  const [tasks, setTasks] = useState([]);
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [selectedTask, setSelectedTask] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [walletChainId, setWalletChainId] = useState(null);
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
    const tasksResult = await api("/gateway/tasks");
    setTasks(tasksResult.tasks || []);
    if (selectedTaskId) {
      const detail = await api(`/gateway/tasks/${selectedTaskId}`);
      setSelectedTask(detail.task);
    } else if (tasksResult.tasks?.[0]) {
      setSelectedTaskId(tasksResult.tasks[0].taskId);
      setSelectedTask(tasksResult.tasks[0]);
    }
  }, [selectedTaskId]);

  const syncWalletState = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum?.request) {
      setWalletAddress("");
      setWalletChainId(null);
      return;
    }

    const [accounts, chainIdHex] = await Promise.all([
      window.ethereum.request({ method: "eth_accounts" }),
      window.ethereum.request({ method: "eth_chainId" })
    ]);
    setWalletAddress(accounts?.[0] || "");
    setWalletChainId(chainIdHex ? Number.parseInt(chainIdHex, 16) : null);
  }, []);

  useEffect(() => {
    refresh().catch((err) => setError(err.message));
    const timer = setInterval(() => refresh().catch(() => {}), 6000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    syncWalletState().catch(() => {});
    if (typeof window === "undefined" || !window.ethereum?.on) {
      return undefined;
    }

    const handleAccountsChanged = (accounts) => {
      setWalletAddress(accounts?.[0] || "");
    };
    const handleChainChanged = (chainIdHex) => {
      setWalletChainId(Number.parseInt(chainIdHex, 16));
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);

    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged);
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [syncWalletState]);

  async function connectWallet() {
    if (typeof window === "undefined" || !window.ethereum?.request) {
      throw new Error("MetaMask-compatible wallet not detected in this browser.");
    }

    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const chainIdHex = await window.ethereum.request({ method: "eth_chainId" });
    setWalletAddress(accounts?.[0] || "");
    setWalletChainId(chainIdHex ? Number.parseInt(chainIdHex, 16) : null);
    return accounts?.[0] || "";
  }

  async function ensureZeroGChain() {
    if (typeof window === "undefined" || !window.ethereum?.request) {
      throw new Error("MetaMask-compatible wallet not detected in this browser.");
    }

    const currentChainIdHex = await window.ethereum.request({ method: "eth_chainId" });
    if (Number.parseInt(currentChainIdHex, 16) === ZERO_G_CHAIN_ID) {
      return;
    }

    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ZERO_G_CHAIN_HEX }]
      });
    } catch (error) {
      if (error?.code !== 4902) {
        throw new Error(`Please switch MetaMask to ${ZERO_G_CHAIN_NAME} before paying.`);
      }

      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: ZERO_G_CHAIN_HEX,
            chainName: ZERO_G_CHAIN_NAME,
            nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 },
            rpcUrls: [ZERO_G_RPC_URL],
            blockExplorerUrls: [ZERO_G_EXPLORER_URL]
          }
        ]
      });
    }

    await syncWalletState();
  }

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
      const result = await api("/gateway/tasks/quote", {
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
      const detail = await api(`/gateway/tasks/${result.taskId}`);
      setSelectedTask(detail.task);
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

  async function verifyPayment(task, overrides = new Map()) {
    const paymentIntent = task?.paymentIntent;
    const payments = submittedPaymentsForTask(task, overrides);

    if (!task?.taskId || !paymentIntent?.id || !walletAddress || !payments.length) {
      throw new Error("Missing task payment details needed for verification.");
    }

    const result = await api(`/gateway/tasks/${task.taskId}/payment/verify`, {
      method: "POST",
      body: JSON.stringify({
        paymentIntentId: paymentIntent.id,
        payerAddress: walletAddress,
        payments
      })
    });
    const detail = await api(`/gateway/tasks/${task.taskId}`);
    setSelectedTask(detail.task);
    await refresh();
    return result;
  }

  async function payWithWallet(task) {
    setWalletBusy(true);
    setError("");
    try {
      const connectedWallet = walletAddress || (await connectWallet());
      if (!connectedWallet) {
        throw new Error("Connect a wallet before paying for this routed task.");
      }

      await ensureZeroGChain();
      const pendingEntries = (task?.paymentIntent?.perNodeAmounts || []).filter((entry) => entry.status !== "verified");
      if (!pendingEntries.length) {
        await verifyPayment(task);
        return;
      }

      const txHashesByPeerId = new Map();
      for (const entry of pendingEntries) {
        const txHash = await window.ethereum.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: connectedWallet,
              to: entry.walletAddress,
              value: decimalToWeiHex(entry.minimumAmount)
            }
          ]
        });
        txHashesByPeerId.set(entry.peerId, txHash);
      }

      await verifyPayment(task, txHashesByPeerId);
    } catch (err) {
      setError(err.message);
    } finally {
      setWalletBusy(false);
    }
  }

  const wrongChain = walletAddress && walletChainId !== null && walletChainId !== ZERO_G_CHAIN_ID;

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Gateway Console</p>
          <h1>Node Nexus</h1>
        </div>
        <nav className="navActions">
          <button className="walletBadge walletButton" onClick={() => connectWallet().catch((err) => setError(err.message))} type="button">
            <Wallet size={14} />
            {walletAddress ? shortenAddress(walletAddress) : "Connect Wallet"}
          </button>
          <Link href="/peers">Live peers</Link>
          <button className="iconButton" onClick={() => refresh()} title="Refresh" type="button">
            <RefreshCcw size={18} />
          </button>
        </nav>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="workspaceSingle">
        <form className="panel submitPanel" onSubmit={submitTask}>
          <div className="panelHeader">
            <div>
              <h2>Get Quote</h2>
              <p>Select paid nodes first, then complete ZeroG testnet payment before dispatch.</p>
            </div>
            <button disabled={busy} type="submit">
              <Coins size={16} />
              {busy ? "Quoting..." : "Create Quote"}
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
        </form>
      </section>

      <section className="reports">
        <div className="taskList panel">
          <div className="panelHeader">
            <div>
              <h2>Tasks</h2>
              <p>Recent routed tasks and payment states.</p>
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
              <h2>Task Detail</h2>
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

              {selectedTask.paymentIntent ? (
                <section className="paymentPanel">
                  <div className="paymentHeader">
                    <div>
                      <h3>ZeroG Payment Gate</h3>
                      <p>Dispatch stays blocked until this native 0G payment is verified.</p>
                    </div>
                    <span className={`paymentStatus ${selectedTask.paymentIntent.status || selectedTask.status}`}>
                      {selectedTask.paymentIntent.status || selectedTask.status}
                    </span>
                  </div>

                  <div className="paymentSummary">
                    <div>
                      <span>Total</span>
                      <strong>{selectedTask.paymentIntent.totalAmount} 0G</strong>
                    </div>
                    <div>
                      <span>Network</span>
                      <strong>{selectedTask.paymentIntent.network}</strong>
                    </div>
                  </div>

                  <div className="quoteRows">
                    {(selectedTask.paymentIntent.perNodeAmounts || []).map((node) => (
                      <div key={`${node.peerId}:${node.walletAddress}`} className="quoteRow">
                        <strong>{node.nodeId || node.peerId}</strong>
                        <span>{node.minimumAmount} 0G</span>
                        <small>{shortenAddress(node.walletAddress)}</small>
                        <small>{node.status || "payment_required"}</small>
                        {node.txHash ? (
                          <a
                            className="textLink"
                            href={`${ZERO_G_EXPLORER_URL.replace(/\/+$/, "")}/tx/${node.txHash}`}
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            {shortenAddress(node.txHash)}
                          </a>
                        ) : null}
                      </div>
                    ))}
                  </div>

                  {selectedTask.paymentIntent.verification?.details?.message ? (
                    <div className="paymentMessage">
                      {selectedTask.paymentIntent.verification.details.message}
                    </div>
                  ) : null}

                  <div className="paymentActions">
                    {!walletAddress ? (
                      <button disabled={walletBusy} onClick={() => connectWallet().catch((err) => setError(err.message))} type="button">
                        <Wallet size={16} />
                        Connect Wallet
                      </button>
                    ) : null}
                    {wrongChain ? <span className="warnText">Switch MetaMask to ZeroG testnet before paying.</span> : null}
                    {selectedTask.status === "payment_required" ? (
                      <>
                        <button disabled={walletBusy || !walletAddress || wrongChain} onClick={() => payWithWallet(selectedTask)} type="button">
                          <Coins size={16} />
                          {walletBusy ? "Paying..." : "Pay Nodes with MetaMask"}
                        </button>
                        {submittedPaymentsForTask(selectedTask).length ? (
                          <button
                            className="secondaryButton"
                            disabled={walletBusy || !walletAddress}
                            onClick={() => verifyPayment(selectedTask).catch((err) => setError(err.message))}
                            type="button"
                          >
                            Verify Submitted Tx
                          </button>
                        ) : null}
                      </>
                    ) : null}
                    {selectedTask.status === "payment_verifying" ? (
                      <span className="muted">Waiting for ZeroG testnet verification.</span>
                    ) : null}
                  </div>
                </section>
              ) : null}

              <div className="reportList">
                {visibleReports(selectedTask.reports).map((report) => {
                  const links = resolveReportLinks(report);
                  return (
                    <article key={report.id}>
                      <div className="reportHead">
                        <StatusIcon status={report.status} />
                        <strong>{report.nodeId || report.peerId || "node"}</strong>
                        <span>{report.location?.country || ""}</span>
                      </div>
                      <p>{report.summary || report.error || "No summary yet."}</p>
                      {links.zeroGDownloadUrl ? (
                        <div className="links">
                          <a href={links.zeroGDownloadUrl} target="_blank" rel="noopener noreferrer">
                            0G link
                          </a>
                          <a href={links.zeroGDownloadUrl} target="_blank" rel="noopener noreferrer" download="report.pdf">
                            Download PDF
                          </a>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {!selectedTask.reports.length ? <p className="muted">Waiting for reports after payment and dispatch.</p> : null}
              </div>
            </>
          ) : (
            <p className="muted">Task quote, payment, and reports will appear here.</p>
          )}
        </div>
      </section>
    </main>
  );
}
