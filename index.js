import WebSocket from "ws";
import { Telegraf } from "telegraf";

console.log("======================================");
console.log(" Pump.fun Holder Fee Monitor");
console.log("======================================");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!TELEGRAM_BOT_TOKEN || !HELIUS_API_KEY) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or HELIUS_API_KEY");
  process.exit(1);
}

const PUMP_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const HELIUS_WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const HELIUS_HTTP_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);
const watchedMints = new Map();

let socket = null;
let reconnectTimer = null;

bot.catch((err) => {
  console.error("❌ Telegram error:", err.message);
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🟢 Bot is online!\n\n" +
    "/watch <CA> - watch a token\n" +
    "/unwatch <CA> - stop watching\n" +
    "/list - show watched tokens\n" +
    "/test - test Telegram"
  );
});

bot.command("test", async (ctx) => {
  await ctx.reply("✅ Telegram is working.");
});

bot.command("watch", async (ctx) => {
  const mint = ctx.message.text.trim().split(/\s+/)[1];

  if (!mint) {
    return ctx.reply("Usage:\n/watch <CA>");
  }

  if (mint.length < 30 || mint.length > 50) {
    return ctx.reply("❌ That doesn't look like a valid Solana CA.");
  }

  if (!watchedMints.has(mint)) {
    watchedMints.set(mint, new Set());
  }

  watchedMints.get(mint).add(ctx.chat.id);

  console.log("======================================");
  console.log("👀 WATCH ADDED");
  console.log("Mint:", mint);
  console.log("Chat:", ctx.chat.id);
  console.log("======================================");

  await ctx.reply(
    "✅ Now watching:\n\n" +
    mint +
    "\n\n" +
    "I'll notify you when Pump.fun executes " +
    "DistributeFeeToHolders for this CA."
  );
});

bot.command("unwatch", async (ctx) => {
  const mint = ctx.message.text.trim().split(/\s+/)[1];

  if (!mint) {
    return ctx.reply("Usage:\n/unwatch <CA>");
  }

  const watchers = watchedMints.get(mint);

  if (!watchers) {
    return ctx.reply("That CA isn't being watched.");
  }

  watchers.delete(ctx.chat.id);

  if (watchers.size === 0) {
    watchedMints.delete(mint);
  }

  await ctx.reply("🛑 Stopped watching:\n\n" + mint);
});

bot.command("list", async (ctx) => {
  if (watchedMints.size === 0) {
    return ctx.reply("No CAs are currently being watched.");
  }

  let text = "👀 WATCHED CAs\n\n";

  for (const [mint, watchers] of watchedMints) {
    text += `${mint}\nWatchers: ${watchers.size}\n\n`;
  }

  await ctx.reply(text);
});

async function heliusRpc(method, params) {
  const response = await fetch(HELIUS_HTTP_URL, {
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

  if (!response.ok) {
    throw new Error(`Helius HTTP ${response.status}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result;
}

async function getTransaction(signature) {
  try {
    return await heliusRpc("getTransaction", [
      signature,
      {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
        encoding: "jsonParsed"
      }
    ]);
  } catch (err) {
    console.error("❌ Transaction lookup failed:", err.message);
    return null;
  }
}

function getAccountKeys(transaction) {
  return (
    transaction?.transaction?.message?.accountKeys
      ?.map((x) => x.pubkey || x)
      || []
  );
}

function findPumpInstruction(transaction) {
  const instructions =
    transaction?.transaction?.message?.instructions || [];

  return instructions.find(
    (instruction) =>
      instruction.programId === PUMP_PROGRAM_ID &&
      Array.isArray(instruction.accounts) &&
      instruction.accounts.length >= 4
  );
}

function findMint(transaction) {
  const instruction = findPumpInstruction(transaction);

  if (!instruction) return null;

  return instruction.accounts[2];
}

function isDistribution(transaction) {
  const instructions =
    transaction?.transaction?.message?.instructions || [];

  const pumpInstruction = instructions.find(
    (instruction) =>
      instruction.programId === PUMP_PROGRAM_ID &&
      Array.isArray(instruction.accounts) &&
      instruction.accounts.length >= 4
  );

  if (!pumpInstruction) return false;

  const logs = transaction?.meta?.logMessages || [];

  return logs.some((log) =>
    log.includes("Instruction: DistributeFeeToHolders")
  );
}

function calculateDistribution(transaction) {
  try {
    const pumpInstruction = findPumpInstruction(transaction);

    if (!pumpInstruction) return null;

    const holderRewards = pumpInstruction.accounts[3];

    const innerInstructions =
      transaction?.meta?.innerInstructions || [];

    let totalLamports = 0;
    let recipients = 0;

    for (const group of innerInstructions) {
      for (const instruction of group.instructions || []) {
        if (
          instruction.parsed &&
          instruction.program === "system" &&
          instruction.parsed.type === "transfer"
        ) {
          const info = instruction.parsed.info;

          if (
            info &&
            info.source === holderRewards &&
            info.lamports
          ) {
            totalLamports += Number(info.lamports);
            recipients++;
          }
        }
      }
    }

    return {
      totalSol: totalLamports / 1_000_000_000,
      recipients
    };
  } catch (err) {
    console.error("❌ Distribution parsing failed:", err.message);
    return null;
  }
}

function connectWebSocket() {
  console.log("🔌 Connecting to Helius WebSocket...");

  socket = new WebSocket(HELIUS_WS_URL);

  socket.on("open", () => {
    console.log("✅ Helius WebSocket connected");

    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
          {
            mentions: [PUMP_PROGRAM_ID]
          },
          {
            commitment: "processed"
          }
        ]
      })
    );
  });

  socket.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      if (data.id === 1) {
        if (data.error) {
          console.error(
            "❌ Helius subscription error:",
            JSON.stringify(data.error)
          );
        } else {
          console.log(
            "✅ Helius subscription active:",
            data.result
          );
        }
        return;
      }

      if (data.method !== "logsNotification") {
        return;
      }

      const value = data.params?.result?.value;

      if (!value || value.err) return;

      const signature = value.signature;
      const logs = value.logs || [];

      const distributionDetected = logs.some((log) =>
        log.includes("Instruction: DistributeFeeToHolders")
      );

      if (!distributionDetected) return;

      console.log("======================================");
      console.log("🚨 DISTRIBUTION DETECTED");
      console.log("Signature:", signature);
      console.log("======================================");

      const transaction = await getTransaction(signature);

      if (!transaction) return;

      const mint = findMint(transaction);

      if (!mint) {
        console.log("❌ Could not determine mint");
        return;
      }

      console.log("🪙 Mint:", mint);

      const watchers = watchedMints.get(mint);

      if (!watchers || watchers.size === 0) {
        console.log("ℹ️ Mint not watched");
        return;
      }

      const distribution =
        calculateDistribution(transaction);

      let message =
        "🚨 HOLDER FEES DISTRIBUTED\n\n" +
        "🪙 CA:\n" +
        mint +
        "\n\n";

      if (distribution) {
        message +=
          "💰 Total: " +
          distribution.totalSol.toFixed(9) +
          " SOL\n" +
          "👥 Recipients: " +
          distribution.recipients +
          "\n\n";
      }

      message +=
        "⚡ Detected: processed\n\n" +
        "🔗 https://solscan.io/tx/" +
        signature;

      for (const chatId of watchers) {
        try {
          await bot.telegram.sendMessage(
            chatId,
            message,
            {
              disable_web_page_preview: true
            }
          );

          console.log("✅ Telegram notification sent");
        } catch (err) {
          console.error(
            "❌ Telegram send failed:",
            err.message
          );
        }
      }
    } catch (err) {
      console.error(
        "❌ WebSocket processing error:",
        err.message
      );
    }
  });

  socket.on("error", (err) => {
    console.error("❌ WebSocket error:", err.message);
  });

  socket.on("close", () => {
    console.log("⚠️ Helius WebSocket disconnected");

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 2000);
    }
  });
}

bot.launch()
  .then(() => {
    console.log("✅ TELEGRAM BOT ONLINE");
    connectWebSocket();
  })
  .catch((err) => {
    console.error("❌ Telegram launch failed:", err.message);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
