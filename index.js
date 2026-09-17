import { Telegraf } from "telegraf";

console.log("=== Starting bot ===");
console.log("TELEGRAM_BOT_TOKEN exists:", !!process.env.TELEGRAM_BOT_TOKEN);
console.log("RPC_URL exists:", !!process.env.RPC_URL);

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN");
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.command("start", (ctx) => {
  ctx.reply("Bot is online! Use /watch <CA> later.");
});

bot.command("watch", (ctx) => {
  const mint = ctx.message.text.split(" ")[1];
  if (!mint) return ctx.reply("Usage: /watch <CA>");
  ctx.reply(`Received CA: ${mint}\n(Detection coming soon)`);
});

bot.launch()
  .then(() => console.log("✅ Telegram bot is ONLINE"))
  .catch((err) => {
    console.error("Launch failed:", err.message);
    process.exit(1);
  });

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
