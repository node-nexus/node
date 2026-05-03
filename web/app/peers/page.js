"use client";

import { AlertCircle, CheckCircle2, Loader2, RefreshCcw, RadioTower } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const DEFAULT_API_PORT = process.env.NEXT_PUBLIC_NODE_NEXUS_API_PORT || "8080";

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

async function api(path) {
  const candidates = apiBaseCandidates();
  let lastNetworkError = null;

  for (let index = 0; index < candidates.length; index += 1) {
    const baseUrl = candidates[index];
    try {
      const response = await fetch(`${baseUrl}${path}`, { cache: "no-store" });
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

export default function PeersPage() {
  const [scan, setScan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      setScan(await api("/gateway/peers"));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const nodes = scan?.nodes || [];

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Live Peer Scan</p>
          <h1>AXL Peers</h1>
        </div>
        <nav className="navActions">
          <Link href="/">Gateway</Link>
          <button className="iconButton" onClick={refresh} disabled={busy} title="Refresh live peers">
            {busy ? <Loader2 className="spin" size={18} /> : <RefreshCcw size={18} />}
          </button>
        </nav>
      </header>

      {error ? <div className="error">{error}</div> : null}

      <section className="peerSummary">
        <div>
          <span>Mode</span>
          <strong>{scan?.mode || "unknown"}</strong>
        </div>
        <div>
          <span>Own peer</span>
          <strong>{scan?.topology?.our_public_key || "not reported"}</strong>
        </div>
        <div>
          <span>Fresh scan</span>
          <strong>{scan?.discoveredAt || "pending"}</strong>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Available Node Nexus Operators</h2>
            <p>Profiles are probed over AXL when this page loads. Nothing here is saved as a node list.</p>
          </div>
          <RadioTower size={18} />
        </div>

        <div className="peerTable">
          <div className="peerHeader">
            <span>Status</span>
            <span>Peer</span>
            <span>Location</span>
            <span>Capabilities</span>
          </div>
          {nodes.map((node) => (
            <div className="peerRow" key={node.peerId}>
              <span className={`peerStatus ${node.profileStatus}`}>
                {node.profileStatus === "available" || node.profileStatus === "mock" ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                {node.profileStatus}
              </span>
              <span>
                <strong>{node.displayName || node.nodeId || "Unnamed peer"}</strong>
                <small>{node.peerId}</small>
              </span>
              <span>
                {[node.location?.country, node.location?.region, node.location?.city]
                  .filter(Boolean)
                  .join(", ") || "unknown"}
                {node.location?.timezone ? <small>{node.location.timezone}</small> : null}
              </span>
              <span className="capList">
                {(node.capabilities || []).slice(0, 8).map((capability) => (
                  <small key={capability}>{capability}</small>
                ))}
                {!node.capabilities?.length ? <small>{node.error || "no profile metadata"}</small> : null}
              </span>
            </div>
          ))}
          {!nodes.length ? <p className="muted">No AXL peers responded to this live scan.</p> : null}
        </div>
      </section>
    </main>
  );
}
