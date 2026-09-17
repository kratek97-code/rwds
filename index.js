import { Connection, PublicKey } from "@solana/web3.js";
import { Telegraf } from "telegraf";

console.log("=== Pump.fun Holder Rewards Bot ===");

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.RPC_URL) {
  console.error("Missing TELEGRAM_BOT_TOKEN or RPC_URL");
  process.exit(1);
}

const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

const connection = new Connection(process.env.RPC_URL, {
  commitment: "processed",
});

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// CA -> Set of Telegram chat IDs
const watchedMints = new Map();

// Prevent duplicate notifications for the same transaction
const processedSignatures = new Set();

/* =========================================================
   TELEGRAM COMMANDS
   ========================================================= */

bot.catch((err) => {
  console.error("Telegram error:", err);
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    "🟢 Pump.fun Holder Rewards Bot is online!\n\n" +
      "/watch <CA> – watch a token\n" +
      "/unwatch <CA> – stop watching\n" +
      "/list – show watched tokens"
  );
});

bot.command("watch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mintString = parts[1];

  if (!mintString) {
    return ctx.reply("Usage: /watch <contract_address>");
  }

  let mint;

  try {
    mint = new PublicKey(mintString);
  } catch {
    return ctx.reply("❌ Invalid Solana contract address.");
  }

  const normalizedMint = mint.toBase58();
  const chatId = ctx.chat.id;

  if (!watchedMints.has(normalizedMint)) {
    watchedMints.set(normalizedMint, new Set());
  }

  watchedMints.get(normalizedMint).add(chatId);

  console.log(
    `Watching ${normalizedMint} for Telegram chat ${chatId}`
  );

  await ctx.reply(
    `✅ Now watching:\n\`${normalizedMint}\`\n\n` +
      `I'll notify you whenever Pump.fun distributes holder fees for this CA.`,
    {
      parse_mode: "Markdown",
    }
  );
});

bot.command("unwatch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mintString = parts[1];

  if (!mintString) {
    return ctx.reply("Usage: /unwatch <CA>");
  }

  let normalizedMint;

  try {
    normalizedMint = new PublicKey(mintString).toBase58();
  } catch {
    return ctx.reply("❌ Invalid Solana contract address.");
  }

  const chatId = ctx.chat.id;

  if (!watchedMints.has(normalizedMint)) {
    return ctx.reply("That CA isn't being watched.");
  }

  const chats = watchedMints.get(normalizedMint);

  chats.delete(chatId);

  if (chats.size === 0) {
    watchedMints.delete(normalizedMint);
  }

  await ctx.reply(`Stopped watching:\n${normalizedMint}`);
});

bot.command("list", async (ctx) => {
  if (watchedMints.size === 0) {
    return ctx.reply("No tokens are currently being watched.");
  }

  let message = "👀 Currently watching:\n\n";

  for (const [mint, chats] of watchedMints.entries()) {
    message += `\`${mint}\` — ${chats.size} watcher(s)\n`;
  }

  await ctx.reply(message, {
    parse_mode: "Markdown",
  });
});

/* =========================================================
   FETCH TRANSACTION
   ========================================================= */

async function getTransactionWithRetry(signature) {
  // At "processed", the log can arrive slightly before
  // the RPC makes the full transaction available.

  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(
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
        `Transaction fetch attempt ${attempt + 1} failed:`,
        err.message
      );
    }

    // Very short retry.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return null;
}

/* =========================================================
   FIND DISTRIBUTE_FEE_TO_HOLDERS INSTRUCTION
   ========================================================= */

function findDistributionInstruction(tx) {
  const instructions =
    tx?.transaction?.message?.instructions || [];

  for (const instruction of instructions) {
    if (!instruction.programId) continue;

    if (!instruction.programId.equals(PUMP_PROGRAM_ID)) {
      continue;
    }

    /*
     * Pump.fun DistributeFeeToHolders account layout:

       #1 Global
       #2 Holder Reward Claim Authority
       #3 Mint
       #4 Holder Rewards
       #5 Holder Rewards Token Account
       #6 Quote Mint
       ...

     * Therefore accounts[2] = MINT
     */

    if (
      instruction.accounts &&
      instruction.accounts.length >= 3
    ) {
      return instruction;
    }
  }

  return null;
}

/* =========================================================
   GET SOL DISTRIBUTION INFORMATION
   ========================================================= */

function getDistributionTransfers(tx) {
  const transfers = [];

  const innerInstructions =
    tx?.meta?.innerInstructions || [];

  for (const inner of innerInstructions) {
    for (const instruction of inner.instructions || []) {
      if (!instruction.parsed) continue;

      if (
        instruction.program === "system" &&
        instruction.parsed.type === "transfer"
      ) {
        const info = instruction.parsed.info;

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

/* =========================================================
   PUMP.FUN LOG LISTENER
   ========================================================= */

connection.onLogs(
  PUMP_PROGRAM_ID,

  async (logInfo) => {
    try {
      if (logInfo.err) {
        return;
      }

      const logs = logInfo.logs || [];

      /*
       * We only care about the actual holder-fee distribution.
       */
      const isHolderDistribution = logs.some((log) =>
        log.includes("Instruction: DistributeFeeToHolders")
      );

      if (!isHolderDistribution) {
        return;
      }

      const signature = logInfo.signature;

      /*
       * Don't process the same transaction twice.
       */
      if (processedSignatures.has(signature)) {
        return;
      }

      processedSignatures.add(signature);

      console.log(
        `⚡ HOLDER DISTRIBUTION DETECTED: ${signature}`
      );

      /*
       * Get the actual transaction so we can identify
       * which CA/mint distributed the fees.
       */
      const tx = await getTransactionWithRetry(signature);

      if (!tx) {
        console.error(
          "Could not retrieve transaction:",
          signature
        );
        return;
      }

      const distributionInstruction =
        findDistributionInstruction(tx);

      if (!distributionInstruction) {
        console.log(
          "Distribution log found but Pump instruction wasn't found."
        );
        return;
      }

      /*
       * Account #3 is the mint.
       *
       * JS array index = 2
       */
      const mint = distributionInstruction.accounts[2].toBase58();

      console.log(`🪙 Distribution mint: ${mint}`);

      /*
       * IMPORTANT:
       *
       * Only notify if this exact CA is being watched.
       */
      const watchers = watchedMints.get(mint);

      if (!watchers || watchers.size === 0) {
        console.log(
          `Ignoring ${mint} — nobody is watching this CA.`
        );
        return;
      }

      /*
       * Find the actual SOL transfers.
       */
      const transfers = getDistributionTransfers(tx);

      const totalLamports = transfers.reduce(
        (sum, transfer) => sum + transfer.lamports,
        0
      );

      const totalSol = totalLamports / 1_000_000_000;

      console.log(
        `💰 ${mint} distributed ${totalSol} SOL`
      );

      console.log(
        `👥 Recipients: ${transfers.length}`
      );

      /*
       * Build Telegram notification.
       */
      const message =
        `🚨 *HOLDER FEES DISTRIBUTED*\n\n` +
        `🪙 CA:\n\`${mint}\`\n\n` +
        `💰 Total: *${totalSol.toFixed(9)} SOL*\n` +
        `👥 Recipients: *${transfers.length}*\n\n` +
        `⚡ Detected: *processed*\n` +
        `🔗 [Transaction](https://solscan.io/tx/${signature})`;

      /*
       * Send to every Telegram user watching this CA.
       */
      for (const chatId of watchers) {
        try {
          await bot.telegram.sendMessage(
            chatId,
            message,
            {
              parse_mode: "Markdown",
              disable_web_page_preview: true,
            }
          );

          console.log(
            `✅ Telegram notification sent to ${chatId}`
          );
        } catch (err) {
          console.error(
            `Telegram send failed for ${chatId}:`,
            err.message
          );
        }
      }
    } catch (err) {
      console.error(
        "Holder distribution processing error:",
        err
      );
    }
  },

  /*
   * IMPORTANT:
   *
   * We use PROCESSED rather than CONFIRMED.
   *
   * You want the earliest notification possible.
   */
  "processed"
);

/* =========================================================
   START
   ========================================================= */

console.log(
  "Listening for Pump.fun DistributeFeeToHolders..."
);

bot
  .launch()
  .then(() => {
    console.log("✅ Telegram bot is ONLINE");
    console.log(
      "⚡ Listening at processed commitment"
    );
  })
  .catch((err) => {
    console.error(
      "Telegram launch error:",
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
