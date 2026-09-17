import { Connection, PublicKey } from "@solana/web3.js";
import { Telegraf } from "telegraf";

console.log("=== Bot starting ===");

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

if (!process.env.RPC_URL || !process.env.RPC_URL.startsWith("https://")) {
  console.error("Missing or invalid RPC_URL (must start with https://)");
  process.exit(1);
}

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const watchedMints = new Set();
const userChats = new Map();

const connection = new Connection(process.env.RPC_URL, "confirmed");
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.catch((err) => console.error("Telegram error:", err.message));

bot.command("start", (ctx) => {
  ctx.reply(
    "Bot is online!\n\n" +
    "Commands:\n" +
    "/watch <CA> – start watching a token\n" +
    "/unwatch <CA> – stop watching\n" +
    "/list – show watched tokens"
  );
});

bot.command("watch", async (ctx) => {
  const mint = ctx.message.text.split(" ")[1];
  if (!mint || mint.length < 30) {
    return ctx.reply("Usage: /watch <contract_address>");
  }
  watchedMints.add(mint);
  userChats.set(mint, ctx.chat.id);
  await ctx.reply(`✅ Now watching:\n${mint}`);
  console.log("Watching:", mint);
});

bot.command("unwatch", (ctx) => {
  const mint = ctx.message.text.split(" ")[1];
  if (!mint) return ctx.reply("Usage: /unwatch <CA>");
  watchedMints.delete(mint);
  userChats.delete(mint);
  ctx.reply(`Stopped watching ${mint}`);
});

bot.command("list", (ctx) => {
  if (watchedMints.size === 0) return ctx.reply("No tokens being watched.");
  ctx.reply([...watchedMints].join("\n"));
});

// Listen for Pump.fun logs
connection.onLogs(
  PUMP_PROGRAM_ID,
  async (logInfo) => {
    try {
      if (logInfo.err) return;

      // Simple detection for now (we will improve it later)
      const logs = logInfo.logs.join("\n");
      
      // Look for distribution-related logs
      if (logs.includes("DistributeFeeToHolders") || logs.includes("distribute_fee_to_holders")) {
        console.log("Possible distribution detected:", logInfo.signature);
        
        // Notify all watched tokens for now (basic version)
        for (const [mint, chatId] of userChats) {
          try {
            await bot.telegram.sendMessage(
              chatId,
              `🚨 Possible Holder Rewards distribution detected!\n\n` +
              `Tx: https://solscan.io/tx/${logInfo.signature}\n` +
              `Watched token: ${mint}`
            );
          } catch (e) {
            console.error("Failed to send message:", e.message);
          }
        }
      }
    } catch (err) {
      console.error("Log error:", err.message);
    }
  },
  "confirmed"
);

console.log("Listening for Pump.fun logs...");

bot.launch()
  .then(() => console.log("✅ Telegram bot is ONLINE and listening"))
  .catch((err) => {
    console.error("Bot launch failed:", err.message);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
