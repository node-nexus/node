const DEFAULT_ZEROG_BASE_URL = "https://router-api-testnet.integratenetwork.work/v1";

function parseJsonFromText(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function qwenConfig(env = process.env) {
  return {
    apiKey: env.ZEROG_API_KEY,
    model: env.ZEROG_MODEL,
    baseUrl: (env.ZEROG_BASE_URL || DEFAULT_ZEROG_BASE_URL).replace(/\/$/, "")
  };
}

export function qwenSelectionConfigured(env = process.env) {
  const config = qwenConfig(env);
  return Boolean(config.apiKey && config.model);
}

export async function selectPeersWithQwen({
  url,
  task,
  targetLocations = [],
  candidates = [],
  maxTargets = 1,
  env = process.env
}) {
  const config = qwenConfig(env);
  if (!config.apiKey || !config.model) {
    throw new Error("Qwen node selection requested but missing ZEROG_API_KEY or ZEROG_MODEL.");
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "You select decentralized Node Nexus operator peers for WebOps tasks. " +
            "Use only the provided candidate list. Return strict JSON only."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              instruction:
                "Choose the best peers for this task. Prefer requested locations, browser-use capability, qwen-agent, screenshots, pdf-report, and 0g-storage-upload. Do not invent peers.",
              outputSchema: {
                selectedPeerIds: ["peer id strings from candidates"],
                rationale: "short reason"
              },
              maxTargets,
              url,
              task,
              targetLocations,
              candidates: candidates.map((candidate) => ({
                peerId: candidate.peerId,
                nodeId: candidate.nodeId,
                displayName: candidate.displayName,
                location: candidate.location,
                capabilities: candidate.capabilities
              }))
            },
            null,
            2
          )
        }
      ]
    })
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`0G Qwen node selection failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }

  const text = body?.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonFromText(text);
  const candidateIds = new Set(candidates.map((candidate) => candidate.peerId));
  const selectedPeerIds = Array.isArray(parsed?.selectedPeerIds)
    ? parsed.selectedPeerIds.filter((peerId) => candidateIds.has(peerId)).slice(0, maxTargets)
    : [];

  return {
    selectedPeerIds,
    rationale: parsed?.rationale || "Qwen returned a selection without rationale.",
    raw: parsed ?? text
  };
}
