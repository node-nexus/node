import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const DEFAULT_PROFILE_PATH = path.join(projectRoot, "config", "node-profile.json");

const SAFE_DEFAULT_PROFILE = {
  nodeId: "node-nexus-unconfigured",
  displayName: "Node Nexus Unconfigured",
  country: "UNCONFIGURED",
  region: "",
  city: "",
  timezone: "UTC",
  languages: [],
  capabilities: [
    "browser-use",
    "qwen-agent",
    "screenshots",
    "pdf-report",
    "0g-storage-upload",
    "axl-mesh"
  ],
  networkType: "operator-local",
  operatorNotes: "No node profile configured. Set NODE_NEXUS_PROFILE_PATH or create config/node-profile.json."
};

function resolveProfilePath(env = process.env) {
  const configuredPath = env.NODE_NEXUS_PROFILE_PATH?.trim();
  if (!configuredPath) {
    return DEFAULT_PROFILE_PATH;
  }

  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(projectRoot, configuredPath);
}

function normalizeProfile(profile) {
  return {
    ...profile,
    languages: Array.isArray(profile.languages) ? profile.languages : [],
    capabilities: Array.isArray(profile.capabilities) ? profile.capabilities : []
  };
}

export function validateNodeProfile(profile) {
  const missing = [];

  for (const field of ["nodeId", "country", "timezone"]) {
    if (!profile[field] || typeof profile[field] !== "string") {
      missing.push(field);
    }
  }

  if (!Array.isArray(profile.capabilities) || profile.capabilities.length === 0) {
    missing.push("capabilities");
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

export function loadNodeProfile(env = process.env) {
  const profilePath = resolveProfilePath(env);
  let profile = SAFE_DEFAULT_PROFILE;
  let source = "safe-defaults";
  let warning = null;

  if (existsSync(profilePath)) {
    try {
      profile = JSON.parse(readFileSync(profilePath, "utf8"));
      source = path.relative(projectRoot, profilePath);
    } catch (error) {
      throw new Error(
        `Failed to read Node Nexus profile at ${profilePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else {
    warning =
      `Node Nexus profile not found at ${path.relative(projectRoot, profilePath)}; ` +
      "using safe unconfigured defaults with no real location.";
    console.warn(`[node-profile] ${warning}`);
  }

  profile = normalizeProfile(profile);
  const validation = validateNodeProfile(profile);
  if (!validation.ok) {
    throw new Error(
      `Invalid Node Nexus profile: missing required field(s): ${validation.missing.join(", ")}`
    );
  }

  return {
    profile,
    profilePath,
    source,
    warning
  };
}

export function nodeLocation(profile) {
  return {
    country: profile.country,
    region: profile.region ?? "",
    city: profile.city ?? "",
    timezone: profile.timezone
  };
}
