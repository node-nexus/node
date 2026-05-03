import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isAddress } from "ethers";

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
  operatorNotes: "No node profile configured. Set NODE_NEXUS_PROFILE_PATH or create config/node-profile.json.",
  payment: null
};

const ZERO_G_PAYMENT_TOKEN = "0G";
const ZERO_G_PAYMENT_NETWORK = "zerog-testnet";

function normalizePayment(payment) {
  if (!payment || typeof payment !== "object") {
    return null;
  }

  const walletAddress = typeof payment.walletAddress === "string" ? payment.walletAddress.trim() : "";
  const minimumAmount = typeof payment.minimumAmount === "string" ? payment.minimumAmount.trim() : "";

  if (!walletAddress && !minimumAmount) {
    return null;
  }

  return {
    walletAddress,
    minimumAmount,
    token: ZERO_G_PAYMENT_TOKEN,
    network: ZERO_G_PAYMENT_NETWORK
  };
}

function isPositiveDecimalString(value) {
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) {
    return false;
  }

  return Number(value) > 0;
}

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
    capabilities: Array.isArray(profile.capabilities) ? profile.capabilities : [],
    payment: normalizePayment(profile.payment)
  };
}

export function validateNodePaymentConfig(payment) {
  if (payment == null) {
    return {
      ok: true,
      enabled: false,
      errors: [],
      normalized: null
    };
  }

  const errors = [];
  if (!payment.walletAddress || !isAddress(payment.walletAddress)) {
    errors.push("payment.walletAddress");
  }
  if (!payment.minimumAmount || !isPositiveDecimalString(payment.minimumAmount)) {
    errors.push("payment.minimumAmount");
  }
  if (payment.token !== ZERO_G_PAYMENT_TOKEN) {
    errors.push("payment.token");
  }
  if (payment.network !== ZERO_G_PAYMENT_NETWORK) {
    errors.push("payment.network");
  }

  return {
    ok: errors.length === 0,
    enabled: true,
    errors,
    normalized: payment
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

  const paymentValidation = validateNodePaymentConfig(profile.payment);
  const paymentErrors = paymentValidation.ok ? [] : paymentValidation.errors;

  return {
    ok: missing.length === 0 && paymentErrors.length === 0,
    missing,
    paymentErrors
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
      `Invalid Node Nexus profile: ${
        [
          validation.missing.length
            ? `missing required field(s): ${validation.missing.join(", ")}`
            : null,
          validation.paymentErrors?.length
            ? `invalid payment field(s): ${validation.paymentErrors.join(", ")}`
            : null
        ]
          .filter(Boolean)
          .join("; ")
      }`
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

export function paymentEligibility(profile) {
  const validation = validateNodePaymentConfig(profile?.payment);
  return {
    eligible: validation.ok && validation.enabled,
    payment: validation.ok ? validation.normalized : null,
    errors: validation.errors
  };
}

export { ZERO_G_PAYMENT_NETWORK, ZERO_G_PAYMENT_TOKEN };
