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
  return {
    privateKey: env.ZEROG_PRIVATE_KEY,
    storageRpcUrl: env.ZEROG_STORAGE_RPC_URL ?? DEFAULT_STORAGE_RPC_URL,
    storageIndexerRpc: env.ZEROG_STORAGE_INDEXER_RPC ?? DEFAULT_STORAGE_INDEXER_RPC
  };
}

export function validateZeroGStorageConfig(env = process.env) {
  const config = resolveZeroGStorageConfig(env);
  const missing = [];

  if (!config.privateKey) {
    missing.push("ZEROG_PRIVATE_KEY");
  }

  return {
    ok: missing.length === 0,
    missing,
    config
  };
}

export async function uploadReportToZeroGStorage(reportPath, env = process.env) {
  const validation = validateZeroGStorageConfig(env);
  if (!validation.ok) {
    throw new Error(
      `Missing 0G Storage configuration: ${validation.missing.join(", ")}`
    );
  }

  const absoluteReportPath = path.isAbsolute(reportPath)
    ? reportPath
    : path.resolve(projectRoot, reportPath);

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
      reportHash: result.rootHash,
      reportUri: `0g://${result.rootHash}`,
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
