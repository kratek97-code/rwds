import { Connection, PublicKey } from "@solana/web3.js";
import { Telegraf } from "telegraf";

console.log("=== Bot starting ===");

if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.RPC_URL) {
  console.error("Missing TELEGRAM_BOT_TOKEN or RPC_URL");
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
    "/watch <CA> – watch a token\n" +
    "/unwatch <CA> – stop watching\n" +
    "/list – show watched tokens"
  );
});

bot.command("watch", async (ctx) => {
  const mint = ctx.message.text.split(" ")[1]?.trim();
  if (!mint || mint.length < 30) {
    return ctx.reply("Usage: /watch <contract_address>");
  }
  watchedMints.add(mint);
  userChats.set(mint, ctx.chat.id);
  await ctx.reply(`✅ Now watching:\n\`${mint}\``, { parse_mode: "Markdown" });
  console.log("Added watch:", mint);
});

bot.command("unwatch", (ctx) => {
  const mint = ctx.message.text.split(" ")[1]?.trim();
  if (!mint) return ctx.reply("Usage: /unwatch <CA>");
  watchedMints.delete(mint);
  userChats.delete(mint);
  ctx.reply(`Stopped watching ${mint}`);
});

bot.command("list", (ctx) => {
  if (watchedMints.size === 0) return ctx.reply("No tokens being watched.");
  ctx.reply("Currently watching:\n" + [...watchedMints].map(m => `\`${m}\``).join("\n"), {
    parse_mode: "Markdown"
  });
});

// Listen for logs
connection.onLogs(
  PUMP_PROGRAM_ID,
  async (logInfo) => {
    try {
      if (logInfo.err || watchedMints.size === 0) return;

      const fullLogs = logInfo.logs.join(" ");

      // Look for the distribution instruction
      if (
        fullLogs.includes("Instruction: DistributeFeeToHolders") ||
        fullLogs.includes("distribute_fee_to_holders") ||
        fullLogs.includes("DistributeFeeToHolders")
      ) {
        console.log("Distribution event found:", logInfo.signature);

        // Notify everyone who is watching any token
        // (We will make it more precise later)
        for (const [mint, chatId] of userChats.entries()) {
          try {
            await bot.telegram.sendMessage(
              chatId,
              `🚨 *Holder Rewards Distribution Detected!*\n\n` +
              `Token: \`${mint}\`\n` +
              `Tx: https://solscan.io/tx/${logInfo.signature}`,
              { parse_mode: "Markdown", disable_web_page_preview: true }
            );
          } catch (e) {
            console.error("Send failed:", e.message);
          }
        }
      }
    } catch (err) {
      console.error("Log processing error:", err.message);
    }
  },
  "confirmed"
);

console.log("Listening for Pump.fun distributions...");

bot.launch()
  .then(() => console.log("✅ Bot is ONLINE and listening"))
  .catch((err) => {
    console.error("Launch error:", err.message);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
