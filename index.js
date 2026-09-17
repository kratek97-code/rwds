import { Connection, PublicKey } from "@solana/web3.js";
import { Telegraf } from "telegraf";

console.log("=== Pump Holder Rewards Bot starting ===");

if (
  !process.env.TELEGRAM_BOT_TOKEN ||
  !process.env.RPC_URL ||
  !process.env.WATCHED_WALLET
) {
  console.error(
    "Missing TELEGRAM_BOT_TOKEN, RPC_URL, or WATCHED_WALLET"
  );
  process.exit(1);
}

const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111"
);

const WATCHED_WALLET = new PublicKey(process.env.WATCHED_WALLET);

const watchedMints = new Set();
const userChats = new Map();

const connection = new Connection(process.env.RPC_URL, {
  commitment: "processed",
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.catch((err) => {
  console.error("Telegram error:", err.message);
});

/* ---------------- TELEGRAM ---------------- */

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🟢 Pump Holder Rewards Bot is online!\n\n" +
    "/watch <CA> – watch a token\n" +
    "/unwatch <CA> – stop watching\n" +
    "/list – show watched tokens\n" +
    "/wallet – show watched wallet"
  );
});

bot.command("wallet", async (ctx) => {
  await ctx.reply(
    `👛 Watched wallet:\n${WATCHED_WALLET.toBase58()}`
  );
});

bot.command("watch", async (ctx) => {
  const mint = ctx.message.text.split(" ")[1]?.trim();

  if (!mint) {
    return ctx.reply("Usage: /watch <contract_address>");
  }

  try {
    new PublicKey(mint);
  } catch {
    return ctx.reply("❌ Invalid Solana address.");
  }

  watchedMints.add(mint);
  userChats.set(mint, ctx.chat.id);

  await ctx.reply(
    `✅ Now watching:\n\`${mint}\``,
    { parse_mode: "Markdown" }
  );

  console.log("Added watch:", mint);
});

bot.command("unwatch", async (ctx) => {
  const mint = ctx.message.text.split(" ")[1]?.trim();

  if (!mint) {
    return ctx.reply("Usage: /unwatch <CA>");
  }

  watchedMints.delete(mint);
  userChats.delete(mint);

  await ctx.reply(`Stopped watching ${mint}`);
});

bot.command("list", async (ctx) => {
  if (watchedMints.size === 0) {
    return ctx.reply("No tokens being watched.");
  }

  await ctx.reply(
    "Currently watching:\n" +
      [...watchedMints]
        .map((m) => `\`${m}\``)
        .join("\n"),
    { parse_mode: "Markdown" }
  );
});

/* ---------------- HELPERS ---------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getTransactionFast(signature) {
  // Try immediately at processed.
  for (let i = 0; i < 5; i++) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: "processed",
        maxSupportedTransactionVersion: 0,
      });

      if (tx) {
        return tx;
      }
    } catch (err) {
      console.error(
        "getParsedTransaction error:",
        err.message
      );
    }

    // Very short retry.
    await sleep(50);
  }

  return null;
}

function isDistributionInstruction(ix) {
  return (
    ix &&
    ix.programId &&
    ix.programId.equals(PUMP_PROGRAM_ID) &&
    ix.accounts &&
    ix.accounts.length >= 3
  );
}

/* ---------------- PUMP LOG LISTENER ---------------- */

connection.onLogs(
  PUMP_PROGRAM_ID,
  async (logInfo) => {
    try {
      if (logInfo.err) return;

      const logs = logInfo.logs || [];

      const isDistribution = logs.some((log) =>
        log.includes("Instruction: DistributeFeeToHolders")
      );

      if (!isDistribution) return;

      const signature = logInfo.signature;

      console.log(
        `⚡ Holder distribution detected: ${signature}`
      );

      const tx = await getTransactionFast(signature);

      if (!tx) {
        console.log(
          "Could not fetch transaction quickly:",
          signature
        );
        return;
      }

      /*
       * Find the Pump distribution instruction.
       *
       * Account layout from the real transaction you provided:
       *
       * #1 Global
       * #2 Holder Reward Claim Authority
       * #3 Mint
       * #4 Holder Rewards
       * #5 Holder Rewards Token Account
       * ...
       * #12 recipient 1
       * #13 recipient 1 ATA
       * #14 recipient 2
       * #15 recipient 2 ATA
       */

      let distributionIx = null;

      for (const ix of tx.transaction.message.instructions) {
        if (isDistributionInstruction(ix)) {
          distributionIx = ix;
          break;
        }
      }

      if (!distributionIx) {
        console.log(
          "Distribution log found but instruction not found."
        );
        return;
      }

      const mint = distributionIx.accounts[2].toBase58();

      console.log("Distribution mint:", mint);

      // Ignore tokens we're not watching.
      if (!watchedMints.has(mint)) {
        console.log("Mint isn't being watched.");
        return;
      }

      /*
       * Find inner SOL transfers.
       *
       * The actual transaction you showed has:
       *
       * Holder Rewards PDA
       *       ↓
       * recipient wallet
       *
       * Holder Rewards PDA
       *       ↓
       * recipient wallet
       */

      const transfers = [];

      if (tx.meta?.innerInstructions) {
        for (const inner of tx.meta.innerInstructions) {
          for (const ix of inner.instructions) {
            if (!ix.parsed) continue;

            if (
              ix.program === "system" &&
              ix.parsed.type === "transfer"
            ) {
              const info = ix.parsed.info;

              if (
                info?.source &&
                info?.destination &&
                info?.lamports
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
      }

      if (transfers.length === 0) {
        console.log(
          "Distribution found but no SOL transfers detected."
        );
        return;
      }

      /*
       * Check whether YOUR wallet received one of the payouts.
       */

      const walletString = WATCHED_WALLET.toBase58();

      const myReward = transfers.find(
        (transfer) =>
          transfer.destination === walletString
      );

      if (!myReward) {
        console.log(
          "Distribution happened, but watched wallet was not a recipient."
        );
        return;
      }

      const solAmount =
        myReward.lamports / 1_000_000_000;

      console.log(
        `💰 REWARD FOUND: ${solAmount} SOL`
      );

      const chatId = userChats.get(mint);

      if (!chatId) {
        console.log(
          "Wallet received reward, but nobody is watching this mint in Telegram."
        );
        return;
      }

      const message =
        `🚨 *HOLDER REWARD RECEIVED*\n\n` +
        `🪙 Token:\n\`${mint}\`\n\n` +
        `💰 Reward: *${solAmount.toFixed(9)} SOL*\n\n` +
        `⚡ Detected at: *processed*\n` +
        `🔗 [Transaction](https://solscan.io/tx/${signature})`;

      await bot.telegram.sendMessage(
        chatId,
        message,
        {
          parse_mode: "Markdown",
          disable_web_page_preview: true,
        }
      );

      console.log(
        `✅ Telegram notification sent for ${mint}`
      );
    } catch (err) {
      console.error(
        "Distribution processing error:",
        err
      );
    }
  },
  "processed"
);

/* ---------------- START ---------------- */

console.log(
  `Watching wallet: ${WATCHED_WALLET.toBase58()}`
);

console.log(
  "Listening for Pump.fun holder reward distributions..."
);

bot
  .launch()
  .then(() => {
    console.log(
      "✅ Telegram bot is ONLINE"
    );
  })
  .catch((err) => {
    console.error(
      "Launch error:",
      err.message
    );

    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
