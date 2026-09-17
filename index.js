import WebSocket from "ws";
import { Telegraf } from "telegraf";

console.log("======================================");
console.log(" Pump.fun Holder Fee Monitor");
console.log("======================================");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!HELIUS_API_KEY) {
  console.error("❌ Missing HELIUS_API_KEY");
  process.exit(1);
}

const PUMP_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const HTTP_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

const watchedMints = new Map();

let ws = null;
let reconnectTimer = null;

/* ======================================
   TELEGRAM ERROR HANDLER
====================================== */

bot.catch((err) => {
  console.error("❌ Telegram error:", err);
});

/* ======================================
   /start
====================================== */

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🟢 Bot is online!\n\n" +
    "/watch <CA> - watch a token\n" +
    "/unwatch <CA> - stop watching\n" +
    "/list - show watched tokens\n" +
    "/test - test Telegram"
  );
});

/* ======================================
   /test
====================================== */

bot.command("test", async (ctx) => {
  await ctx.reply("✅ Telegram is working.");
});

/* ======================================
   /watch
====================================== */

bot.command("watch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mint = parts[1];

  if (!mint) {
    await ctx.reply("Usage:\n/watch <CA>");
    return;
  }

  if (mint.length < 30 || mint.length > 50) {
    await ctx.reply(
      "❌ That doesn't look like a valid Solana CA."
    );
    return;
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

/* ======================================
   /unwatch
====================================== */

bot.command("unwatch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mint = parts[1];

  if (!mint) {
    await ctx.reply("Usage:\n/unwatch <CA>");
    return;
  }

  const watchers = watchedMints.get(mint);

  if (!watchers) {
    await ctx.reply("That CA isn't being watched.");
    return;
  }

  watchers.delete(ctx.chat.id);

  if (watchers.size === 0) {
    watchedMints.delete(mint);
  }

  await ctx.reply(
    "🛑 Stopped watching:\n\n" + mint
  );
});

/* ======================================
   /list
====================================== */

bot.command("list", async (ctx) => {
  if (watchedMints.size === 0) {
    await ctx.reply(
      "No CAs are currently being watched."
    );
    return;
  }

  let listText = "👀 WATCHED CAs\n\n";

  for (const [mint, watchers] of watchedMints) {
    listText +=
      mint +
      "\nWatchers: " +
      watchers.size +
      "\n\n";
  }

  await ctx.reply(listText);
});

/* ======================================
   HELIUS WEBSOCKET
====================================== */

function connectWebSocket() {
  console.log(
    "🔌 Connecting to Helius WebSocket..."
  );

  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log(
      "======================================"
    );

    console.log(
      "✅ Helius WebSocket connected"
    );

    console.log(
      "======================================"
    );

    const subscription = {
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
    };

    ws.send(
      JSON.stringify(subscription)
    );

    console.log(
      "📡 Subscribed to Pump.fun logs"
    );

    console.log(
      "⚡ Commitment: processed"
    );
  });

  ws.on("message", async (raw) => {
    try {
      const wsMessage =
        JSON.parse(raw.toString());

      /*
       * Subscription confirmation
       */

      if (
        wsMessage.result !== undefined &&
        wsMessage.id === 1
      ) {
        console.log(
          "✅ Subscription ID:",
          wsMessage.result
        );

        return;
      }

      /*
       * Ignore non-log messages
       */

      if (
        wsMessage.method !==
        "logsNotification"
      ) {
        return;
      }

      const value =
        wsMessage.params?.result?.value;

      if (!value) {
        return;
      }

      if (value.err) {
        return;
      }

      const signature =
        value.signature;

      const logs =
        value.logs || [];

      /*
       * Look for the exact Pump.fun
       * holder-fee distribution instruction.
       */

      const isDistribution =
        logs.some((log) =>
          log.includes(
            "Instruction: DistributeFeeToHolders"
          )
        );

      if (!isDistribution) {
        return;
      }

      console.log(
        "======================================"
      );

      console.log(
        "🚨 DISTRIBUTE_FEE_TO_HOLDERS"
      );

      console.log(
        "Signature:",
        signature
      );

      console.log(
        "======================================"
      );

      /*
       * Get the transaction.
       */

      const transaction =
        await getTransaction(
          signature
        );

      if (!transaction) {
        console.log(
          "❌ Transaction not available."
        );

        return;
      }

      /*
       * Find the mint.
       */

      const mint =
        getMintFromTransaction(
          transaction
        );

      if (!mint) {
        console.log(
          "❌ Couldn't determine mint."
        );

        return;
      }

      console.log(
        "🪙 Distribution mint:",
        mint
      );

      /*
       * Only notify people watching
       * THIS specific mint.
       */

      const watchers =
        watchedMints.get(mint);

      if (
        !watchers ||
        watchers.size === 0
      ) {
        console.log(
          "ℹ️ CA isn't being watched."
        );

        return;
      }

      /*
       * Get distribution information.
       */

      const distribution =
        getDistributionInfo(
          transaction
        );

      let telegramMessage =
        "🚨 HOLDER FEES DISTRIBUTED\n\n" +
        "🪙 CA:\n" +
        mint +
        "\n\n";

      if (distribution) {
        telegramMessage +=
          "💰 Total: " +
          distribution.totalSol.toFixed(9) +
          " SOL\n" +
          "👥 Recipients: " +
          distribution.recipients +
          "\n\n";
      }

      telegramMessage +=
        "⚡ Detected: processed\n\n" +
        "🔗 https://solscan.io/tx/" +
        signature;

      /*
       * Send Telegram notification.
       */

      for (const chatId of watchers) {
        try {
          await bot.telegram.sendMessage(
            chatId,
            telegramMessage,
            {
              disable_web_page_preview: true
            }
          );

          console.log(
            "✅ Telegram notification sent"
          );
        } catch (err) {
          console.error(
            "❌ Telegram send failed:",
            err.message
          );
        }
      }
    } catch (err) {
      console.error(
        "❌ WebSocket message error:",
        err
      );
    }
  });

  ws.on("error", (err) => {
    console.error(
      "❌ WebSocket error:",
      err.message
    );
  });

  ws.on("close", () => {
    console.log(
      "⚠️ Helius WebSocket disconnected"
    );

    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 2000);
    }
  });
}

/* ======================================
   HELIUS RPC
====================================== */

async function heliusRpc(
  method,
  params
) {
  const response = await fetch(
    HTTP_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Helius HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (data.error) {
    throw new Error(
      data.error.message
    );
  }

  return data.result;
}

/* ======================================
   GET TRANSACTION
====================================== */

async function getTransaction(
  signature
) {
  try {
    return await heliusRpc(
      "getTransaction",
      [
        signature,
        {
          commitment: "processed",
          maxSupportedTransactionVersion: 0,
          encoding: "jsonParsed"
        }
      ]
    );
  } catch (err) {
    console.error(
      "❌ Transaction lookup failed:",
      err.message
    );

    return null;
  }
}

/* ======================================
   FIND MINT
====================================== */

function getMintFromTransaction(
  transaction
) {
  try {
    const instructions =
      transaction.transaction
        ?.message
        ?.instructions || [];

    /*
     * Pump.fun distribution accounts:
     *
     * #1 Global
     * #2 Holder Reward Claim Authority
     * #3 Mint
     * #4 Holder Rewards
     */

    for (const instruction of instructions) {
      if (
        instruction.programId ===
          PUMP_PROGRAM_ID &&
        instruction.accounts &&
        instruction.accounts.length >= 3
      ) {
        return instruction.accounts[2];
      }
    }

    return null;
  } catch (err) {
    console.error(
      "❌ Mint parsing failed:",
      err.message
    );

    return null;
  }
}

/* ======================================
   DISTRIBUTION INFORMATION
====================================== */

function getDistributionInfo(
  transaction
) {
  try {
    const instructions =
      transaction.transaction
        ?.message
        ?.instructions || [];

    let pumpInstruction = null;

    for (const instruction of instructions) {
      if (
        instruction.programId ===
          PUMP_PROGRAM_ID &&
        instruction.accounts &&
        instruction.accounts.length >= 4
      ) {
        pumpInstruction =
          instruction;

        break;
      }
    }

    if (!pumpInstruction) {
      return null;
    }

    /*
     * Account #4 = Holder Rewards
     */

    const holderRewards =
      pumpInstruction.accounts[3];

    const innerInstructions =
      transaction.meta
        ?.innerInstructions || [];

    let totalLamports = 0;
    let recipients = 0;

    for (
      const group of innerInstructions
    ) {
      for (
        const instruction of
          group.instructions || []
      ) {
        if (!instruction.parsed) {
          continue;
        }

        if (
          instruction.program ===
            "system" &&
          instruction.parsed.type ===
            "transfer"
        ) {
          const info =
            instruction.parsed.info;

          if (
            info &&
            info.source ===
              holderRewards &&
            info.lamports
          ) {
            totalLamports +=
              Number(info.lamports);

            recipients++;
          }
        }
      }
    }

    return {
      totalSol:
        totalLamports /
        1000000000,

      recipients
    };
  } catch (err) {
    console.error(
      "❌ Distribution parsing error:",
      err.message
    );

    return null;
  }
}

/* ======================================
   START
====================================== */

bot
  .launch()
  .then(() => {
    console.log(
      "======================================"
    );

    console.log(
      "✅ TELEGRAM BOT ONLINE"
    );

    console.log(
      "======================================"
    );

    connectWebSocket();
  })
  .catch((err) => {
    console.error(
      "❌ Telegram launch failed:",
      err
    );

    process.exit(1);
  });

/* ======================================
   SHUTDOWN
====================================== */

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
