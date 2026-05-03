import { ethers } from "ethers";

import { ZERO_G_PAYMENT_NETWORK, ZERO_G_PAYMENT_TOKEN } from "./nodeProfile.js";

export const ZERO_G_TESTNET_CHAIN_ID = 16602n;
export const ZERO_G_TESTNET_CHAIN_HEX = `0x${ZERO_G_TESTNET_CHAIN_ID.toString(16)}`;
export const ZERO_G_TESTNET_CHAIN_NAME = "0G-Testnet-Galileo";
export const ZERO_G_TESTNET_CURRENCY = {
  name: "0G",
  symbol: "0G",
  decimals: 18
};
export const DEFAULT_ZERO_G_TESTNET_RPC_URL = "https://evmrpc-testnet.0g.ai";
export const DEFAULT_ZERO_G_TESTNET_EXPLORER_URL = "https://chainscan-galileo.0g.ai";

export function parseZeroGAmount(amount) {
  return ethers.parseUnits(String(amount ?? "").trim(), ZERO_G_TESTNET_CURRENCY.decimals);
}

export function formatZeroGAmount(amountWei) {
  return ethers.formatUnits(amountWei, ZERO_G_TESTNET_CURRENCY.decimals);
}

export function sumZeroGAmounts(amounts) {
  return amounts.reduce((total, value) => total + parseZeroGAmount(value), 0n);
}

export function resolveZeroGPaymentConfig(env = process.env) {
  return {
    rpcUrl: env.ZERO_G_PAYMENT_RPC_URL?.trim() || DEFAULT_ZERO_G_TESTNET_RPC_URL,
    explorerUrl: env.ZERO_G_PAYMENT_EXPLORER_URL?.trim() || DEFAULT_ZERO_G_TESTNET_EXPLORER_URL,
    chainId: ZERO_G_TESTNET_CHAIN_ID,
    chainHex: ZERO_G_TESTNET_CHAIN_HEX,
    chainName: ZERO_G_TESTNET_CHAIN_NAME,
    token: ZERO_G_PAYMENT_TOKEN,
    network: ZERO_G_PAYMENT_NETWORK,
    nativeCurrency: ZERO_G_TESTNET_CURRENCY,
    minConfirmations: Number(env.ZERO_G_PAYMENT_MIN_CONFIRMATIONS ?? 1)
  };
}

export function validateZeroGPaymentConfig(input = process.env) {
  const config =
    input && typeof input === "object" && "rpcUrl" in input ? input : resolveZeroGPaymentConfig(input);

  return {
    ok: true,
    missing: [],
    invalid: [],
    config
  };
}

export function createZeroGPaymentProvider(config = resolveZeroGPaymentConfig()) {
  return new ethers.JsonRpcProvider(config.rpcUrl);
}

export async function verifyZeroGPayment({
  provider,
  txHash,
  payerAddress,
  receiverAddress,
  requiredAmount,
  expectedChainId = ZERO_G_TESTNET_CHAIN_ID,
  minConfirmations = 1
}) {
  const normalizedPayerAddress = ethers.getAddress(payerAddress);
  const normalizedReceiverAddress = ethers.getAddress(receiverAddress);
  const requiredAmountWei = parseZeroGAmount(requiredAmount);

  const [network, tx, receipt, latestBlockNumber] = await Promise.all([
    provider.getNetwork(),
    provider.getTransaction(txHash),
    provider.getTransactionReceipt(txHash),
    provider.getBlockNumber()
  ]);

  const actualChainId = BigInt(network.chainId);

  if (actualChainId !== BigInt(expectedChainId)) {
    return {
      ok: false,
      code: "wrong_chain",
      message: `Transaction was checked on chain ${actualChainId}, expected ${expectedChainId}.`,
      details: { actualChainId: actualChainId.toString() }
    };
  }

  if (!tx) {
    return {
      ok: false,
      code: "unknown_tx",
      message: "Transaction not found on ZeroG testnet.",
      details: {}
    };
  }

  if (BigInt(tx.chainId ?? actualChainId) !== BigInt(expectedChainId)) {
    return {
      ok: false,
      code: "wrong_chain",
      message: `Transaction chainId ${tx.chainId} does not match ZeroG testnet.`,
      details: { actualChainId: String(tx.chainId) }
    };
  }

  if (!receipt) {
    return {
      ok: false,
      code: "unconfirmed_tx",
      message: "Transaction has not been mined yet.",
      details: {}
    };
  }

  const confirmations = receipt.blockNumber ? Math.max(0, latestBlockNumber - receipt.blockNumber + 1) : 0;
  const actualTo = tx.to ? ethers.getAddress(tx.to) : null;
  const actualFrom = tx.from ? ethers.getAddress(tx.from) : null;
  const valueWei = BigInt(tx.value ?? 0n);

  if (receipt.status !== 1) {
    return {
      ok: false,
      code: "tx_failed",
      message: "Transaction reverted or failed on-chain.",
      details: {
        confirmations,
        blockNumber: receipt.blockNumber ?? null
      }
    };
  }

  if (confirmations < minConfirmations) {
    return {
      ok: false,
      code: "insufficient_confirmations",
      message: `Transaction has ${confirmations} confirmation(s); ${minConfirmations} required.`,
      details: {
        confirmations,
        blockNumber: receipt.blockNumber ?? null
      }
    };
  }

  if (actualTo !== normalizedReceiverAddress) {
    return {
      ok: false,
      code: "wrong_recipient",
      message: "Transaction recipient does not match the payment intent receiver.",
      details: { actualTo }
    };
  }

  if (actualFrom !== normalizedPayerAddress) {
    return {
      ok: false,
      code: "wrong_payer",
      message: "Transaction sender does not match the submitted payer address.",
      details: { actualFrom }
    };
  }

  if (valueWei < requiredAmountWei) {
    return {
      ok: false,
      code: "insufficient_amount",
      message: "Transaction value is below the required payment total.",
      details: {
        actualAmount: formatZeroGAmount(valueWei),
        requiredAmount: requiredAmount
      }
    };
  }

  return {
    ok: true,
    code: "verified",
    message: "Payment verified on ZeroG testnet.",
    details: {
      actualChainId: actualChainId.toString(),
      actualTo,
      actualFrom,
      actualAmount: formatZeroGAmount(valueWei),
      requiredAmount,
      confirmations,
      blockNumber: receipt.blockNumber ?? null
    }
  };
}
