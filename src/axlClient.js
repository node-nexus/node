const DEFAULT_AXL_API_URL = "http://127.0.0.1:9002";

function resolveAxlApiUrl(env = process.env) {
  return String(env.AXL_API_URL || DEFAULT_AXL_API_URL).replace(/\/$/, "");
}

async function readResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  return await response.text();
}

export async function getAxlTopology(env = process.env) {
  const response = await fetch(`${resolveAxlApiUrl(env)}/topology`);
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`AXL topology failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

export async function callAxlMcp({
  peerId,
  service = process.env.NODE_NEXUS_MCP_SERVICE || "node-nexus",
  request,
  env = process.env
}) {
  if (!peerId || typeof peerId !== "string") {
    throw new Error("AXL MCP call requires a target peerId.");
  }

  const endpoint = `${resolveAxlApiUrl(env)}/mcp/${encodeURIComponent(peerId)}/${encodeURIComponent(service)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request)
  });
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`AXL MCP call failed for ${peerId}: HTTP ${response.status} ${JSON.stringify(body)}`);
  }

  return body;
}

export function axlClientConfig(env = process.env) {
  return {
    apiUrl: resolveAxlApiUrl(env),
    service: env.NODE_NEXUS_MCP_SERVICE || "node-nexus"
  };
}
