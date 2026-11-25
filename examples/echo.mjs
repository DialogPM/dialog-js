// A bot that greets, repeats what it is told and answers its buttons.
//
//     npm run build && DIALOG_BOT_TOKEN=... node examples/echo.mjs
//
// DIALOG_BASE_URL selects another server than the official one. In your own project the
// import is "dialogpm-bot".

import { Bot, DEFAULT_BASE_URL, DialogError, button } from "../dist/index.js";

const bot = new Bot(process.env.DIALOG_BOT_TOKEN, { baseUrl: process.env.DIALOG_BASE_URL || DEFAULT_BASE_URL });
console.log("running as @" + (await bot.getMe()).username);
// A 1x1 PNG, so the example needs no file.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

await bot.setMyCommands([
  ["start", "Say hello"],
  ["buttons", "Show two buttons"],
  ["photo", "Send a picture"],
]);

for await (const update of bot.updates()) {
  try {
    if (update.message) {
      const m = update.message;
      if (m.command === "start") await bot.sendMessage(m.chatId, "Hello from JavaScript");
      else if (m.command === "photo") await bot.sendPhoto(m.chatId, PIXEL, { caption: "A picture" });
      else if (m.command === "buttons") await bot.sendMessage(m.chatId, "Pick one", { buttons: [button.callback("Yes", "yes"), button.callback("No", "no")] });
      else await bot.sendMessage(m.chatId, "You said: " + m.text);
    } else if (update.callbackQuery) {
      await bot.sendMessage(update.callbackQuery.chatId, "You pressed " + update.callbackQuery.data);
    }
  } catch (e) {
    if (!(e instanceof DialogError && e.stopped)) throw e;
  }
}
