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

export function resolveZeroGStorageConfig(env = process.env) {
  const uploadMode = normalizeUploadMode(env);
  return {
    uploadMode,
    privateKey: env.ZERO_G_PRIVATE_KEY ?? env.ZEROG_PRIVATE_KEY,
    storageRpcUrl: env.ZERO_G_STORAGE_RPC_URL ?? env.ZEROG_STORAGE_RPC_URL,
    storageIndexerRpc: env.ZERO_G_STORAGE_INDEXER_URL ?? env.ZEROG_STORAGE_INDEXER_RPC,
    storageLogLevel: env.ZERO_G_STORAGE_LOG_LEVEL ?? "info"
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
      storageIndexerRpc: config.storageIndexerRpc ?? DEFAULT_STORAGE_INDEXER_RPC
    },
    configured: config.uploadMode === "disabled" || missing.length === 0
  };
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

  const { privateKey, storageRpcUrl, storageIndexerRpc } = validation.config;
  const provider = new ethers.JsonRpcProvider(storageRpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const indexer = new Indexer(storageIndexerRpc);
  const file = await ZgFile.fromFilePath(absoluteReportPath);

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
    try {
      [result, uploadError] = await indexer.upload(file, storageRpcUrl, signer);
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
      localRootHash: rootHash,
      txHash: result.txHash || null,
      txSeq: result.txSeq ?? null,
      storageRpcUrl,
      storageIndexerRpc
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
    metadataHash: metadataUpload?.hash ?? null,
    metadataUri: metadataUpload?.uri ?? null,
    txHash: reportUpload.txHash,
    metadataTxHash: metadataUpload?.txHash ?? null,
    storageRpcUrl: reportUpload.storageRpcUrl,
    storageIndexerRpc: reportUpload.storageIndexerRpc
  };
}
