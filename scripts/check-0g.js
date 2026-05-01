import dotenv from "dotenv";

dotenv.config();

const DEFAULT_ZEROG_BASE_URL = "https://router-api-testnet.integratenetwork.work/v1";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in .env`);
  }

  return value;
}

function redact(value) {
  if (!value || value.length <= 10) {
    return "<redacted>";
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

async function main() {
  const apiKey = requiredEnv("ZEROG_API_KEY");
  const model = process.env.ZEROG_MODEL ?? "qwen/qwen-2.5-7b-instruct";
  const baseUrl = process.env.ZEROG_BASE_URL ?? DEFAULT_ZEROG_BASE_URL;
  const endpoint = new URL("chat/completions", `${baseUrl.replace(/\/$/, "")}/`);

  console.log("Checking 0G testnet inference credentials");
  console.log(`baseUrl=${baseUrl}`);
  console.log(`model=${model}`);
  console.log(`apiKey=${redact(apiKey)}`);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with OK." }],
      stream: false,
      max_tokens: 8
    })
  });

  const body = await response.text();

  if (!response.ok) {
    console.error(`0G testnet check failed: HTTP ${response.status}`);
    console.error(body);
    process.exit(1);
  }

  console.log("0G testnet check passed.");
  console.log(body);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
