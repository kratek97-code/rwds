import WebSocket from "ws";
import { Telegraf } from "telegraf";

const WALLET = "EzHAQTwGH3e8F4Lf8hyB7afM3JPU6YD1oZP4ZT2jC2wY";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!HELIUS_API_KEY) {
  console.error("Missing HELIUS_API_KEY");
  process.exit(1);
}

if (!TELEGRAM_CHAT_ID) {
  console.error("Missing TELEGRAM_CHAT_ID");
  process.exit(1);
}

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

let socket;
let subscriptionId = null;
let previousLamports = null;
let reconnectTimer = null;
const processedSignatures = new Set();

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

async function getBalance() {
  const result = await rpc("getBalance", [
    WALLET,
    { commitment: "processed" }
  ]);

  return result.value;
}

async function getRecentSignatures() {
  return await rpc("getSignaturesForAddress", [
    WALLET,
    {
      limit: 10
    }
  ]);
}

async function getTransaction(signature) {
  return await rpc("getTransaction", [
    signature,
    {
      commitment: "processed",
      maxSupportedTransactionVersion: 0,
      encoding: "jsonParsed"
    }
  ]);
}

async function getSolPrice() {
  try {
    const response = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    );

    const data = await response.json();

    return Number(data.solana?.usd || 0);
  } catch (err) {
    console.error("SOL price error:", err.message);
    return 0;
  }
}

function shorten(address) {
  if (address.length <= 10) return address;
  return address.slice(0, 4) + "..." + address.slice(-4);
}

function getIncomingSol(transaction) {
  if (!transaction?.meta) return null;

  const accountKeys =
    transaction.transaction?.message?.accountKeys || [];

  let walletIndex = -1;

  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys[i];

    const pubkey =
      typeof key === "string"
        ? key
        : key.pubkey;

    if (pubkey === WALLET) {
      walletIndex = i;
      break;
    }
  }

  if (walletIndex === -1) return null;

  const pre = transaction.meta.preBalances?.[walletIndex];
  const post = transaction.meta.postBalances?.[walletIndex];

  if (
    typeof pre !== "number" ||
    typeof post !== "number"
  ) {
    return null;
  }

  const difference = post - pre;

  if (difference <= 0) return null;

  const fee =
    transaction.meta.fee || 0;

  const transactionInstructions =
    transaction.transaction?.message?.instructions || [];

  let directTransfer = false;
  let sender = null;

  for (const instruction of transactionInstructions) {
    if (
      instruction.program === "system" &&
      instruction.parsed?.type === "transfer"
    ) {
      const info = instruction.parsed.info;

      if (
        info.destination === WALLET &&
        Number(info.lamports) > 0
      ) {
        directTransfer = true;
        sender = info.source;
      }
    }
  }

  if (!directTransfer) return null;

  return {
    lamports: difference,
    sender,
    fee
  };
}

async function sendNotification(amountSol, sender, signature) {
  const price = await getSolPrice();
  const usd = amountSol * price;

  const senderText = sender
    ? shorten(sender)
    : "Unknown";

  const message =
    `Received: **${amountSol.toFixed(3)}** #SOL ($${usd.toFixed(2)}) from [${senderText}]` +
    `\n\n` +
    `[View TX](https://solscan.io/tx/${signature})`;

  await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    message,
    {
      parse_mode: "Markdown",
      disable_web_page_preview: true
    }
  );

  console.log("✅ Notification sent:", message);
}

async function findIncomingTransfer() {
  try {
    const signatures = await getRecentSignatures();

    for (const item of signatures) {
      const signature = item.signature;

      if (processedSignatures.has(signature)) {
        continue;
      }

      processedSignatures.add(signature);

      const transaction =
        await getTransaction(signature);

      if (!transaction) continue;

      if (transaction.meta?.err) continue;

      const incoming =
        getIncomingSol(transaction);

      if (!incoming) continue;

      const amountSol =
        incoming.lamports / 1_000_000_000;

      console.log("======================================");
      console.log("🚨 INCOMING SOL");
      console.log("Amount:", amountSol);
      console.log("From:", incoming.sender);
      console.log("Signature:", signature);
      console.log("======================================");

      await sendNotification(
        amountSol,
        incoming.sender,
        signature
      );
    }

    if (processedSignatures.size > 200) {
      const first =
        processedSignatures.values().next().value;

      processedSignatures.delete(first);
    }
  } catch (err) {
    console.error(
      "Transfer detection error:",
      err.message
    );
  }
}

function connect() {
  console.log("🔌 Connecting to Helius...");

  socket = new WebSocket(WS_URL);

  socket.on("open", async () => {
    console.log("✅ Helius WebSocket connected");

    try {
      previousLamports = await getBalance();

      console.log(
        "Initial balance:",
        previousLamports / 1_000_000_000,
        "SOL"
      );
    } catch (err) {
      console.error(
        "Initial balance error:",
        err.message
      );
    }

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "accountSubscribe",
        params: [
          WALLET,
          {
            commitment: "processed",
            encoding: "base64"
          }
        ]
      })
    );

    console.log("📡 Account subscription sent");
  });

  socket.on("message", async (raw) => {
    try {
      const data =
        JSON.parse(raw.toString());

      if (
        data.id === 1 &&
        data.result !== undefined
      ) {
        subscriptionId = data.result;

        console.log(
          "✅ Account subscription active:",
          subscriptionId
        );

        return;
      }

      if (
        data.method !== "accountNotification"
      ) {
        return;
      }

      const newLamports =
        data.params?.result?.value?.lamports;

      if (
        typeof newLamports !== "number"
      ) {
        return;
      }

      if (
        previousLamports === null
      ) {
        previousLamports = newLamports;
        return;
      }

      const increase =
        newLamports - previousLamports;

      console.log(
        "Balance change:",
        increase / 1_000_000_000,
        "SOL"
      );

      if (increase > 0) {
        await findIncomingTransfer();
      }

      previousLamports = newLamports;
    } catch (err) {
      console.error(
        "WebSocket processing error:",
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
    console.log(
      "⚠️ Helius disconnected"
    );

    subscriptionId = null;

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

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
