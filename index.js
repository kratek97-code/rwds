import WebSocket from "ws";

const WALLET = "EzHAQTwGH3e8F4Lf8hyB7afM3JPU6YD1oZP4ZT2jC2wY";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || !HELIUS_API_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID or HELIUS_API_KEY");
  process.exit(1);
}

const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

let socket;
let reconnectTimer;
const seen = new Set();

console.log("======================================");
console.log(" SOLANA WALLET TRANSFER MONITOR");
console.log("======================================");
console.log("Wallet:", WALLET);

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result;
}

async function sendTelegram(message) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
        disable_web_page_preview: true
      })
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(data.description || "Telegram send failed");
  }
}

async function getTransaction(signature) {
  for (let i = 0; i < 10; i++) {
    try {
      const tx = await rpc("getTransaction", [
        signature,
        {
          encoding: "jsonParsed",
          commitment: "processed",
          maxSupportedTransactionVersion: 0
        }
      ]);

      if (tx) return tx;
    } catch (err) {
      console.error("RPC:", err.message);
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  return null;
}

async function getSolPrice() {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );

    const data = await response.json();
    return Number(data?.solana?.usd || 0);
  } catch {
    return 0;
  }
}

function shortAddress(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function findIncomingSol(tx) {
  const instructions =
    tx?.transaction?.message?.instructions || [];

  for (const instruction of instructions) {
    if (
      instruction.program === "system" &&
      instruction.parsed?.type === "transfer"
    ) {
      const info = instruction.parsed.info;

      if (
        info?.destination === WALLET &&
        Number(info.lamports) > 0
      ) {
        return {
          amount: Number(info.lamports) / 1_000_000_000,
          sender: info.source
        };
      }
    }
  }

  return null;
}

async function processTransaction(signature) {
  if (seen.has(signature)) return;
  seen.add(signature);

  if (seen.size > 500) {
    seen.delete(seen.values().next().value);
  }

  console.log("📨 Transaction:", signature);

  const tx = await getTransaction(signature);

  if (!tx || tx.meta?.err) return;

  const transfer = findIncomingSol(tx);

  if (!transfer) return;

  const price = await getSolPrice();
  const usd = transfer.amount * price;

  const message =
    `Received: **${transfer.amount.toFixed(3)}** #SOL ($${usd.toFixed(2)}) from [${shortAddress(transfer.sender)}]` +
    `\n\n` +
    `[View TX](https://solscan.io/tx/${signature})`;

  try {
    await sendTelegram(message);

    console.log("✅ Notification sent");
  } catch (err) {
    console.error("❌ Telegram:", err.message);
  }
}

function connect() {
  console.log("🔌 Connecting to Helius...");

  socket = new WebSocket(WS_URL);

  socket.on("open", () => {
    console.log("✅ Helius WebSocket connected");

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          {
            mentions: [WALLET]
          },
          {
            commitment: "processed"
          }
        ]
      })
    );

    console.log("📡 Wallet subscription sent");
  });

  socket.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.id === 1) {
        if (data.error) {
          console.error(
            "❌ Subscription error:",
            JSON.stringify(data.error)
          );
        } else {
          console.log(
            "✅ Wallet subscription active:",
            data.result
          );
        }
        return;
      }

      if (data.method !== "logsNotification") return;

      const value = data.params?.result?.value;

      if (!value || value.err) return;

      await processTransaction(value.signature);
    } catch (err) {
      console.error("❌ Processing:", err.message);
    }
  });

  socket.on("error", (err) => {
    console.error("❌ WebSocket:", err.message);
  });

  socket.on("close", () => {
    console.log("⚠️ Helius disconnected");

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, 2000);
    }
  });
}

console.log("🚀 Starting monitor...");
connect();
