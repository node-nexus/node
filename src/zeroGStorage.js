import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Indexer, ZgFile } from "@0gfoundation/0g-storage-ts-sdk";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const DEFAULT_STORAGE_RPC_URL = "https://evmrpc-testnet.0g.ai";
const DEFAULT_STORAGE_INDEXER_RPC = "https://indexer-storage-testnet-turbo.0g.ai";
const DEFAULT_STORAGE_DOWNLOAD_BASE_URL = "https://indexer-storage-testnet-turbo.0g.ai";
const DEFAULT_UPLOAD_TIMEOUT_MS = 600000;

function normalizeUploadMode(env = process.env) {
  const mode = String(env.ZERO_G_UPLOAD_MODE ?? "disabled").trim().toLowerCase();
  if (["real", "disabled"].includes(mode)) {
    return mode;
  }

  throw new Error(`Invalid ZERO_G_UPLOAD_MODE=${env.ZERO_G_UPLOAD_MODE}. Expected real or disabled.`);
}

function formatError(error, walletAddress) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("insufficient funds")) {
    return [
      "insufficient funds for the 0G Storage upload wallet",
      walletAddress ? `(${walletAddress})` : "",
      "Fund the wallet configured by ZEROG_PRIVATE_KEY on the selected 0G network and retry."
    ]
      .filter(Boolean)
      .join(" ");
  }

  return message;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function resolveZeroGStorageConfig(env = process.env) {
  const uploadMode = normalizeUploadMode(env);
  return {
    uploadMode,
    privateKey: env.ZERO_G_PRIVATE_KEY ?? env.ZEROG_PRIVATE_KEY,
    storageRpcUrl: env.ZERO_G_STORAGE_RPC_URL ?? env.ZEROG_STORAGE_RPC_URL,
    storageIndexerRpc: env.ZERO_G_STORAGE_INDEXER_URL ?? env.ZEROG_STORAGE_INDEXER_RPC,
    storageDownloadBaseUrl:
      env.ZERO_G_STORAGE_DOWNLOAD_BASE_URL ??
      env.ZEROG_STORAGE_DOWNLOAD_BASE_URL ??
      env.ZERO_G_STORAGE_INDEXER_URL ??
      env.ZEROG_STORAGE_INDEXER_RPC,
    storageLogLevel: env.ZERO_G_STORAGE_LOG_LEVEL ?? "info",
    uploadTimeoutMs: positiveInt(env.ZERO_G_UPLOAD_TIMEOUT_MS, DEFAULT_UPLOAD_TIMEOUT_MS),
    expectedReplica: positiveInt(env.ZERO_G_EXPECTED_REPLICA, 1)
  };
}

export function validateZeroGStorageConfig(env = process.env) {
  const config = resolveZeroGStorageConfig(env);
  const missing = [];

  if (config.uploadMode === "real") {
    if (!config.storageRpcUrl) {
      missing.push("ZERO_G_STORAGE_RPC_URL");
    }

    if (!config.storageIndexerRpc) {
      missing.push("ZERO_G_STORAGE_INDEXER_URL");
    }

    if (!config.privateKey) {
      missing.push("ZERO_G_PRIVATE_KEY");
    }
  }

  return {
    ok: missing.length === 0,
    missing,
    config: {
      ...config,
      storageRpcUrl: config.storageRpcUrl ?? DEFAULT_STORAGE_RPC_URL,
      storageIndexerRpc: config.storageIndexerRpc ?? DEFAULT_STORAGE_INDEXER_RPC,
      storageDownloadBaseUrl: config.storageDownloadBaseUrl ?? DEFAULT_STORAGE_DOWNLOAD_BASE_URL
    },
    configured: config.uploadMode === "disabled" || missing.length === 0
  };
}

function buildIndexerDownloadUrl(baseUrl, rootHash, fileName) {
  if (!baseUrl || !rootHash) {
    return null;
  }
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/file`;
  parsed.search = "";
  parsed.searchParams.set("root", rootHash);
  if (fileName) {
    parsed.searchParams.set("name", fileName);
  }
  return parsed.toString();
}

function resolveLocalPath(filePath) {
  if (!filePath) {
    return null;
  }

  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

async function uploadFileToZeroGStorage(filePath, env = process.env) {
  const validation = validateZeroGStorageConfig(env);
  if (!validation.ok) {
    throw new Error("0G upload requested but missing ZERO_G_* env vars.");
  }

  const absoluteReportPath = resolveLocalPath(filePath);

  if (!existsSync(absoluteReportPath)) {
    throw new Error(`Report PDF not found at ${absoluteReportPath}`);
  }

  const {
    privateKey,
    storageRpcUrl,
    storageIndexerRpc,
    storageDownloadBaseUrl,
    uploadTimeoutMs,
    expectedReplica
  } = validation.config;
  const provider = new ethers.JsonRpcProvider(storageRpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const indexer = new Indexer(storageIndexerRpc);
  const file = await ZgFile.fromFilePath(absoluteReportPath);
  const fileName = path.basename(absoluteReportPath);

  try {
    const [tree, treeError] = await file.merkleTree();
    if (treeError) {
      throw new Error(`Failed to prepare 0G Storage Merkle tree: ${formatError(treeError)}`);
    }

    const rootHash = tree?.rootHash();
    if (!rootHash) {
      throw new Error("Failed to prepare 0G Storage Merkle tree: missing root hash");
    }

    let result;
    let uploadError;
    const uploadOptions = {
      finalityRequired: true,
      expectedReplica,
      skipTx: true,
      skipIfFinalized: true,
      onProgress: (message) => {
        console.log(`[0g-storage] ${fileName}: ${message}`);
      }
    };
    try {
      [result, uploadError] = await withTimeout(
        indexer.upload(file, storageRpcUrl, signer, uploadOptions),
        uploadTimeoutMs,
        `0G Storage upload timed out after ${uploadTimeoutMs}ms while waiting for storage finalization`
      );
    } catch (error) {
      throw new Error(`0G Storage upload failed: ${formatError(error, signer.address)}`);
    }

    if (uploadError) {
      throw new Error(`0G Storage upload failed: ${formatError(uploadError, signer.address)}`);
    }

    if (!result?.rootHash) {
      throw new Error("0G Storage upload did not return a root hash");
    }

    return {
      hash: result.rootHash,
      uri: `0g://${result.rootHash}`,
      downloadUrl: buildIndexerDownloadUrl(storageDownloadBaseUrl, result.rootHash, fileName),
      localRootHash: rootHash,
      txHash: result.txHash || null,
      txSeq: result.txSeq ?? null,
      storageRpcUrl,
      storageIndexerRpc,
      expectedReplica,
      finalityRequired: true
    };
  } finally {
    await file.close();
  }
}

export async function uploadReportToZeroGStorage({ reportPath, metadataPath }, env = process.env) {
  const validation = validateZeroGStorageConfig(env);

  if (validation.config.uploadMode === "disabled") {
    return {
      uploadMode: "disabled",
      status: "disabled",
      reportUri: null,
      metadataUri: null,
      reportDownloadUrl: null,
      metadataDownloadUrl: null,
      reportHash: null,
      metadataHash: null,
      reportPath,
      metadataPath
    };
  }

  if (!validation.ok) {
    throw new Error("0G upload requested but missing ZERO_G_* env vars.");
  }

  const reportUpload = await uploadFileToZeroGStorage(reportPath, env);
  const metadataUpload = metadataPath ? await uploadFileToZeroGStorage(metadataPath, env) : null;

  return {
    uploadMode: "real",
    status: "uploaded",
    reportHash: reportUpload.hash,
    reportUri: reportUpload.uri,
    reportDownloadUrl: reportUpload.downloadUrl ?? null,
    metadataHash: metadataUpload?.hash ?? null,
    metadataUri: metadataUpload?.uri ?? null,
    metadataDownloadUrl: metadataUpload?.downloadUrl ?? null,
    txHash: reportUpload.txHash,
    metadataTxHash: metadataUpload?.txHash ?? null,
    storageRpcUrl: reportUpload.storageRpcUrl,
    storageIndexerRpc: reportUpload.storageIndexerRpc
  };
}
