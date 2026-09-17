import WebSocket from "ws";
import { Telegraf } from "telegraf";

const WALLET = "EzHAQTwGH3e8F4Lf8hyB7afM3JPU6YD1oZP4ZT2jC2wY";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !HELIUS_API_KEY || !TELEGRAM_CHAT_ID) {
  console.error("❌ Missing Railway variable");
  process.exit(1);
}

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

let socket;
let reconnectTimer = null;

const seen = new Set();

console.log("======================================");
console.log(" SOLANA WALLET TRANSFER MONITOR");
console.log("======================================");
console.log("Wallet:", WALLET);

async function rpc(method, params) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
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

async function getTransaction(signature) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const tx = await rpc("getTransaction", [
        signature,
        {
          commitment: "processed",
          maxSupportedTransactionVersion: 0,
          encoding: "jsonParsed"
        }
      ]);

      if (tx) return tx;
    } catch (err) {
      console.error("RPC error:", err.message);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
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

function shorten(address) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function getIncomingTransfer(tx) {
  const message = tx?.transaction?.message;

  if (!message) return null;

  const accountKeys = message.accountKeys || [];

  let walletIndex = -1;

  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys[i];

    const address =
      typeof key === "string"
        ? key
        : key.pubkey;

    if (address === WALLET) {
      walletIndex = i;
      break;
    }
  }

  if (walletIndex === -1) return null;

  const instructions = message.instructions || [];

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
          lamports: Number(info.lamports),
          sender: info.source
        };
      }
    }
  }

  return null;
}

async function handleTransaction(signature) {
  if (seen.has(signature)) return;

  seen.add(signature);

  if (seen.size > 500) {
    seen.delete(seen.values().next().value);
  }

  console.log("📨 Wallet transaction:", signature);

  const tx = await getTransaction(signature);

  if (!tx) {
    console.log("⏳ Transaction not available yet");
    return;
  }

  if (tx.meta?.err) return;

  const transfer = getIncomingTransfer(tx);

  if (!transfer) {
    console.log("↪️ Not an incoming SOL transfer");
    return;
  }

  const sol = transfer.lamports / 1_000_000_000;

  const price = await getSolPrice();

  const usd = sol * price;

  const sender = shorten(transfer.sender);

  const message =
    `Received: **${sol.toFixed(3)}** #SOL ($${usd.toFixed(2)}) from [${sender}]` +
    `\n\n` +
    `[View TX](https://solscan.io/tx/${signature})`;

  try {
    await bot.telegram.sendMessage(
      TELEGRAM_CHAT_ID,
      message,
      {
        parse_mode: "Markdown",
        disable_web_page_preview: true
      }
    );

    console.log("======================================");
    console.log("✅ NOTIFICATION SENT");
    console.log(message);
    console.log("======================================");
  } catch (err) {
    console.error("❌ Telegram error:", err.message);
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

    console.log("📡 Wallet logs subscription sent");
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

      if (data.method !== "logsNotification") {
        return;
      }

      const value =
        data.params?.result?.value;

      if (!value || value.err) return;

      await handleTransaction(value.signature);
    } catch (err) {
      console.error(
        "❌ WebSocket processing error:",
        err.message
      );
    }
  });

  socket.on("error", (err) => {
    console.error(
      "❌ WebSocket error:",
      err.message
    );
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

bot.launch()
  .then(() => {
    console.log("✅ TELEGRAM ONLINE");
    connect();
  })
  .catch((err) => {
    console.error(
      "❌ Telegram launch failed:",
      err.message
    );

    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
