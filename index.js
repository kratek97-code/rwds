import { Connection, PublicKey } from "@solana/web3.js";
import { Telegraf } from "telegraf";

console.log("======================================");
console.log(" Pump.fun Holder Rewards Bot");
console.log("======================================");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RPC_URL = process.env.RPC_URL;

if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!RPC_URL) {
  console.error("❌ Missing RPC_URL");
  process.exit(1);
}

const PUMP_PROGRAM_ID =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const connection = new Connection(RPC_URL, {
  commitment: "processed",
});

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

/*
 * Map:
 * mint -> Set of Telegram chat IDs
 */
const watchedMints = new Map();

/*
 * Prevent duplicate alerts.
 */
const alertedTransactions = new Set();

/*
 * ============================================================
 * TELEGRAM
 * ============================================================
 */

bot.catch((err) => {
  console.error("Telegram error:", err);
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🟢 Bot is online!\n\n" +
      "Commands:\n" +
      "/watch <CA> - watch a token\n" +
      "/unwatch <CA> - stop watching\n" +
      "/list - show watched tokens\n" +
      "/test - test Telegram"
  );
});

bot.command("test", async (ctx) => {
  await ctx.reply(
    "✅ Telegram is working.\n\n" +
      "Now waiting for Pump.fun holder-fee distributions."
  );
});

bot.command("watch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const address = parts[1];

  if (!address) {
    await ctx.reply("Usage:\n/watch <CA>");
    return;
  }

  let mint;

  try {
    mint = new PublicKey(address).toBase58();
  } catch {
    await ctx.reply("❌ Invalid Solana address.");
    return;
  }

  if (!watchedMints.has(mint)) {
    watchedMints.set(mint, new Set());
  }

  watchedMints.get(mint).add(ctx.chat.id);

  console.log("======================================");
  console.log("👀 NEW WATCH");
  console.log("Mint:", mint);
  console.log("Chat:", ctx.chat.id);
  console.log("======================================");

  await ctx.reply(
    "✅ Watching CA:\n\n" +
      mint +
      "\n\n" +
      "I'll notify you when Pump.fun executes\n" +
      "DistributeFeeToHolders for this CA."
  );
});

bot.command("unwatch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const address = parts[1];

  if (!address) {
    await ctx.reply("Usage:\n/unwatch <CA>");
    return;
  }

  let mint;

  try {
    mint = new PublicKey(address).toBase58();
  } catch {
    await ctx.reply("❌ Invalid Solana address.");
    return;
  }

  const chats = watchedMints.get(mint);

  if (!chats) {
    await ctx.reply("That CA isn't being watched.");
    return;
  }

  chats.delete(ctx.chat.id);

  if (chats.size === 0) {
    watchedMints.delete(mint);
  }

  await ctx.reply(
    "🛑 Stopped watching:\n\n" + mint
  );
});

bot.command("list", async (ctx) => {
  if (watchedMints.size === 0) {
    await ctx.reply("No CAs are being watched.");
    return;
  }

  let message = "👀 WATCHED CAs\n\n";

  for (const [mint, chats] of watchedMints) {
    message += `${mint}\n`;
    message += `Watchers: ${chats.size}\n\n`;
  }

  await ctx.reply(message);
});

/*
 * ============================================================
 * TRANSACTION FETCH
 * ============================================================
 */

async function fetchTransaction(signature) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const tx =
        await connection.getParsedTransaction(
          signature,
          {
            commitment: "processed",
            maxSupportedTransactionVersion: 0,
          }
        );

      if (tx) {
        return tx;
      }
    } catch (err) {
      console.error(
        "Transaction fetch error:",
        err.message
      );
    }

    await new Promise((resolve) =>
      setTimeout(resolve, 100)
    );
  }

  return null;
}

/*
 * ============================================================
 * FIND PUMP DISTRIBUTION INSTRUCTION
 * ============================================================
 */

function findPumpDistribution(tx) {
  const instructions =
    tx?.transaction?.message?.instructions || [];

  for (const ix of instructions) {
    if (!ix.programId) continue;

    if (
      ix.programId.toBase58() !==
      PUMP_PROGRAM_ID
    ) {
      continue;
    }

    /*
     * DistributeFeeToHolders has:
     *
     * accounts[0] = Global
     * accounts[1] = Holder Reward Claim Authority
     * accounts[2] = Mint
     *
     * Therefore accounts[2] is the CA.
     */

    if (
      ix.accounts &&
      ix.accounts.length >= 3
    ) {
      return ix;
    }
  }

  return null;
}

/*
 * ============================================================
 * GET SOL TRANSFERS
 * ============================================================
 */

function getSolTransfers(tx) {
  const transfers = [];

  const inner =
    tx?.meta?.innerInstructions || [];

  for (const group of inner) {
    for (const ix of group.instructions || []) {
      if (!ix.parsed) continue;

      if (
        ix.program === "system" &&
        ix.parsed.type === "transfer"
      ) {
        const info = ix.parsed.info;

        if (
          info &&
          info.source &&
          info.destination &&
          info.lamports !== undefined
        ) {
          transfers.push({
            source: info.source,
            destination: info.destination,
            lamports: Number(info.lamports),
          });
        }
      }
    }
  }

  return transfers;
}

/*
 * ============================================================
 * PUMP.FUN LOG LISTENER
 * ============================================================
 *
 * TEMPORARILY listening to "all".
 *
 * This is intentional.
 *
 * We want to prove that Railway/RPC is actually receiving
 * Solana logs.
 */

console.log("Connecting to Solana...");
console.log("RPC:", RPC_URL.replace(/\/\/.*@/, "//***@"));
console.log("Pump program:", PUMP_PROGRAM_ID);
console.log("Commitment: processed");
console.log("Starting log subscription...");

connection.onLogs(
  "all",

  async (logInfo) => {
    try {
      /*
       * Diagnostic.
       *
       * If Railway is working, you should see these constantly.
       */
      console.log(
        "📡 LOG:",
        logInfo.signature
      );

      if (logInfo.err) {
        return;
      }

      const logs = logInfo.logs || [];

      /*
       * Look specifically for the instruction from the
       * real transaction you showed me.
       */

      const isDistribution = logs.some((log) =>
        log.includes(
          "Instruction: DistributeFeeToHolders"
        )
      );

      if (!isDistribution) {
        return;
      }

      console.log("");
      console.log(
        "======================================"
      );
      console.log(
        "🚨 HOLDER FEE DISTRIBUTION DETECTED"
      );
      console.log(
        "======================================"
      );
      console.log(
        "Signature:",
        logInfo.signature
      );

      const signature = logInfo.signature;

      if (
        alertedTransactions.has(signature)
      ) {
        return;
      }

      alertedTransactions.add(signature);

      /*
       * Get the full transaction.
       */

      const tx =
        await fetchTransaction(signature);

      if (!tx) {
        console.error(
          "❌ Could not fetch transaction"
        );
        return;
      }

      /*
       * Find the Pump instruction.
       */

      const instruction =
        findPumpDistribution(tx);

      if (!instruction) {
        console.error(
          "❌ Found distribution log but couldn't find Pump instruction"
        );
        return;
      }

      /*
       * Account #3 = mint.
       *
       * Array index 2 = account #3.
       */

      const mint =
        instruction.accounts[2].toBase58();

      console.log(
        "🪙 Mint:",
        mint
      );

      /*
       * Only notify watchers of THIS CA.
       */

      const watchers =
        watchedMints.get(mint);

      if (
        !watchers ||
        watchers.size === 0
      ) {
        console.log(
          "ℹ️ This CA isn't being watched."
        );

        return;
      }

      /*
       * Get actual SOL transfers.
       */

      const transfers =
        getSolTransfers(tx);

      /*
       * The distribution transaction can contain
       * other system transfers, so we're interested
       * in the transfers originating from the
       * Holder Rewards account.
       *
       * Account #4 is the Holder Rewards account.
       */

      const holderRewardsAccount =
        instruction.accounts[3].toBase58();

      const rewardTransfers =
        transfers.filter(
          (transfer) =>
            transfer.source ===
            holderRewardsAccount
        );

      let totalLamports = 0;

      for (const transfer of rewardTransfers) {
        totalLamports +=
          transfer.lamports;
      }

      const totalSol =
        totalLamports / 1_000_000_000;

      console.log(
        "💰 Total distributed:",
        totalSol,
        "SOL"
      );

      console.log(
        "👥 Recipients:",
        rewardTransfers.length
      );

      /*
       * Send Telegram.
       */

      const message =
        "🚨 HOLDER FEES DISTRIBUTED\n\n" +
        "🪙 CA:\n" +
        mint +
        "\n\n" +
        "💰 Total distributed: " +
        totalSol.toFixed(9) +
        " SOL\n" +
        "👥 Recipients: " +
        rewardTransfers.length +
        "\n\n" +
        "⚡ Detected at: processed\n\n" +
        "🔗 https://solscan.io/tx/" +
        signature;

      for (const chatId of watchers) {
        try {
          await bot.telegram.sendMessage(
            chatId,
            message,
            {
              disable_web_page_preview: true,
            }
          );

          console.log(
            "✅ Telegram notification sent to:",
            chatId
          );
        } catch (err) {
          console.error(
            "❌ Telegram send error:",
            err.message
          );
        }
      }
    } catch (err) {
      console.error(
        "❌ Listener error:",
        err
      );
    }
  },

  "processed"
);

/*
 * ============================================================
 * START TELEGRAM BOT
 * ============================================================
 */

bot
  .launch()
  .then(() => {
    console.log("");
    console.log(
      "======================================"
    );
    console.log(
      "✅ TELEGRAM BOT ONLINE"
    );
    console.log(
      "======================================"
    );
    console.log(
      "Waiting for Pump.fun holder distributions..."
    );
  })
  .catch((err) => {
    console.error(
      "❌ Telegram launch failed:",
      err
    );

    process.exit(1);
  });

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
