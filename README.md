# dialogpm-bot

JavaScript and TypeScript client for the Bot API of [Dialog](https://dialog.pm), the private
messenger. Send yourself (or anyone who starts your bot) a notification from a script, a
server or a cron job: text, pictures and buttons.

- No dependencies. Node 20.3+, Bun and Deno; types included.
- A bot writes only to people who started it, and stops when they stop it.
- The bot never learns who it is talking to: a chat id is random and different for every bot.

## Install

```
npm install dialogpm-bot
```

## Create a bot

In the Dialog app: **Settings → Bots → New bot**. You get a token and a public link
(`dialog.pm/@your_bot`). Open the link, press **Start**, and the chat id appears in the
list of subscribers.

## Send a message

```js
import { Bot } from "dialogpm-bot";

const bot = new Bot("TOKEN");
await bot.sendMessage("CHAT_ID", "Backup finished");
```

Pictures and buttons:

```js
import { Bot, button } from "dialogpm-bot";

await bot.sendPhoto("CHAT_ID", "door.jpg", {
  caption: "*Motion at the door*",
  buttons: [button.callback("Ignore", "ignore"), button.link("Live view", "https://example.org/cam")],
});
```

A picture is a path, a `Uint8Array` (a `Buffer`), an `ArrayBuffer` or a `Blob`.

## Answer people

```js
for await (const update of bot.updates()) {      // long polling, forever
  if (update.message) {
    const m = update.message;
    if (m.command === "start") await bot.sendMessage(m.chatId, "Hello! I will write here when something happens.");
    else await bot.sendMessage(m.chatId, `You said: ${m.text}`);
  } else if (update.callbackQuery) {
    const q = update.callbackQuery;
    await bot.sendMessage(q.chatId, `You pressed ${q.data}`);
  } else if (update.chatStopped) {
    console.log("stopped by", update.chatStopped.chatId);
  }
}
```

`bot.updates({ signal })` ends when the signal is aborted.

Commands offered after `/` in the chat:

```js
await bot.setMyCommands([["status", "How things are"], ["help", "What I can do"]]);
```

## Errors

A refused call rejects with a `DialogError` that has `status`, `code`, `message` and, when
the server gives one, a `reason`:

| `reason` | Meaning |
|---|---|
| `bot_stopped` | The user stopped the bot (`error.stopped` is true). Do not write to this chat until it sends `/start` again. |
| `chat_not_found` | Not a chat of this bot. |
| `bot_disabled` | The server operator switched the bot off. |

A `429` carries `retryAfter` (seconds). When the server cannot be reached `status` is 0 and
`code` is `network` or `timeout`. The token never appears in an error.

## Another server

Dialog can be self-hosted. Pass the server's address:

```js
const bot = new Bot("TOKEN", { baseUrl: "https://chat.example.org" });
```

## Good to know

Messages exchanged with bots are **not** end-to-end encrypted: the bot's script and the
server can read them. Everything else in Dialog is.

## License

MIT
