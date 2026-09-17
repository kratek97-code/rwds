import { Connection, PublicKey } from "@solana/web3.js";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { Telegraf } from "telegraf";

const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const watchedMints = new Set();
const userChats = new Map();

const connection = new Connection(process.env.RPC_URL, "confirmed");
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

bot.command("start", (ctx) => {
  ctx.reply(
    "Send me a token CA with:\n\n/watch <CA>\n\nExample:\n/watch 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU\n\nI'll notify you when holder rewards are distributed."
  );
});

bot.command("watch", (ctx) => {
  const mint = ctx.message.text.split(" ")[1];
  if (!mint || mint.length < 32) {
    return ctx.reply("Usage: /watch <contract_address>");
  }
  watchedMints.add(mint);
  userChats.set(mint, ctx.chat.id);
  ctx.reply(`✅ Now watching:\n${mint}`);
});

bot.command("unwatch", (ctx) => {
  const mint = ctx.message.text.split(" ")[1];
  if (!mint) return ctx.reply("Usage: /unwatch <CA>");
  watchedMints.delete(mint);
  userChats.delete(mint);
  ctx.reply(`Stopped watching ${mint}`);
});

bot.command("list", (ctx) => {
  if (watchedMints.size === 0) return ctx.reply("Not watching any tokens yet.");
  ctx.reply("Currently watching:\n" + [...watchedMints].join("\n"));
});

connection.onLogs(
  PUMP_PROGRAM_ID,
  async (logInfo) => {
    try {
      const { logs, signature, err } = logInfo;
      if (err) return;

      for (const log of logs) {
        if (!log.startsWith("Program data: ")) continue;

        const data = Buffer.from(log.slice(14), "base64");
        try {
          const event = PUMP_SDK.decodeDistributeFeeToHoldersEvent(data);
          const mint = event.mint.toBase58();

          if (watchedMints.has(mint)) {
            const chatId = userChats.get(mint);
            const msg =
              `🚨 Holder Rewards just distributed!\n\n` +
              `Token: ${mint}\n` +
              `Total paid: ${event.total.toString()}\n` +
              `Recipients: ${event.recipients.toString()}\n` +
              `Tx: https://solscan.io/tx/${signature}`;

            if (chatId) {
              await bot.telegram.sendMessage(chatId, msg);
            }
            console.log(msg);
          }
        } catch (e) {}
      }
    } catch (e) {
      console.error(e);
    }
  },
  "confirmed"
);

bot.launch();
console.log("Bot is running!");
