// The client against a small stand-in for the Bot API (no network, no Dialog server).

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { inspect } from "node:util";

import { Bot, DialogError, button } from "../dist/index.js";

const TOKEN = "tok/en-SECRET";
let server;
let bot;
let calls = [];
let answers = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const [, , token, method] = url.pathname.split("/");
      calls.push({ token, method, headers: req.headers, query: url.searchParams, body: Buffer.concat(chunks) });
      const a = answers.shift() ?? { status: 200, payload: { ok: true, result: true } };
      if (a.hang) return; // never answers
      res.writeHead(a.status, { "Content-Type": "application/json", ...(a.headers ?? {}) });
      res.end(a.raw ?? JSON.stringify(a.payload));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  bot = new Bot(TOKEN, { baseUrl: `http://127.0.0.1:${server.address().port}/` });
});

after(() => {
  server.closeAllConnections();
  server.close();
});

beforeEach(() => {
  calls = [];
  answers = [];
});

const ok = (result) => answers.push({ status: 200, payload: { ok: true, result } });
const last = () => calls.at(-1);
const json = (call) => JSON.parse(call.body.toString());

test("sendMessage with buttons", async () => {
  ok({ message_id: "m1", date: 7, chat: { id: "c1" } });
  const sent = await bot.sendMessage("c1", "Motion", { buttons: [[button.callback("Ignore", "ignore:7"), button.link("Live", "https://example.org")]], silent: true });
  assert.deepEqual(sent, { messageId: "m1", chatId: "c1", date: 7 });
  assert.equal(last().token, "tok%2Fen-SECRET");
  assert.equal(last().method, "sendMessage");
  assert.match(last().headers["user-agent"], /^dialog-bot-js\//);
  assert.deepEqual(json(last()), {
    chat_id: "c1",
    text: "Motion",
    silent: true,
    buttons: [[{ text: "Ignore", data: "ignore:7" }, { text: "Live", url: "https://example.org" }]],
  });
});

test("a flat list of buttons is one row", async () => {
  ok({ message_id: "m", date: 1, chat: { id: "c" } });
  await bot.sendMessage("c", "x", { buttons: [button.callback("A", "a"), button.callback("B", "b")] });
  assert.deepEqual(json(last()).buttons, [[{ text: "A", data: "a" }, { text: "B", data: "b" }]]);
  await assert.rejects(bot.sendMessage("c", "x", { buttons: [{ text: "neither" }] }), TypeError);
  await assert.rejects(bot.sendMessage("c", "x", { buttons: [{ text: "both", data: "d", url: "https://e.org" }] }), TypeError);
  assert.equal(calls.length, 1);
});

test("plain sendMessage sends nothing extra", async () => {
  ok({ message_id: "m", date: 1, chat: { id: "c" } });
  await bot.sendMessage("c", 'ăîș "q"');
  assert.deepEqual(json(last()), { chat_id: "c", text: 'ăîș "q"' });
});

test("sendPhoto sends the bytes", async () => {
  ok({ message_id: "m2", date: 8, chat: { id: "c1" } });
  const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(20, 48)]);
  const sent = await bot.sendPhoto("c1", new Uint8Array(png), { caption: "Front door & more", buttons: [button.callback("Ok", "ok")] });
  assert.equal(sent.messageId, "m2");
  const call = last();
  assert.equal(call.method, "sendPhoto");
  assert.match(call.headers["content-type"], /^image\//);
  assert.deepEqual(call.body, png);
  assert.equal(call.query.get("chat_id"), "c1");
  assert.equal(call.query.get("caption"), "Front door & more");
  assert.equal(call.query.get("silent"), null);
  assert.deepEqual(JSON.parse(call.query.get("buttons")), [[{ text: "Ok", data: "ok" }]]);
});

test("sendPhoto reads a path", async () => {
  ok({ message_id: "m3", date: 8, chat: { id: "c1" } });
  const path = new URL(import.meta.url).pathname;
  await bot.sendPhoto("c1", path, { silent: true });
  assert.ok(last().body.toString().includes("sendPhoto reads a path"));
  assert.equal(last().query.get("silent"), "true");
});

test("getUpdates", async () => {
  ok([
    { update_id: 5, message: { message_id: "u1", chat: { id: "c1" }, date: 1, text: "/Status now" } },
    { update_id: 6, callback_query: { chat: { id: "c1" }, message_id: "m1", data: "yes", date: 2 } },
    { update_id: 7, chat_stopped: { chat: { id: "c2" }, date: 3 } },
    { update_id: 8, message: { message_id: "u2", chat: { id: "c1" }, date: 4, text: "hello /there" } },
  ]);
  const got = await bot.getUpdates({ offset: 5, timeout: 500 });
  assert.deepEqual(json(last()), { offset: 5, limit: 100, timeout: 50 });
  assert.deepEqual(got[0], { updateId: 5, chatId: "c1", message: { messageId: "u1", chatId: "c1", date: 1, text: "/Status now", command: "status" } });
  assert.deepEqual(got[1], { updateId: 6, chatId: "c1", callbackQuery: { chatId: "c1", messageId: "m1", data: "yes", date: 2 } });
  assert.deepEqual(got[2], { updateId: 7, chatId: "c2", chatStopped: { chatId: "c2", date: 3 } });
  assert.equal(got[3].message.command, undefined);
});

test("updates() confirms what was handled and stops on abort", async () => {
  ok([{ update_id: 3, message: { message_id: "a", chat: { id: "c" }, date: 1, text: "one" } }, { update_id: 4, message: { message_id: "b", chat: { id: "c" }, date: 1, text: "two" } }]);
  ok([{ update_id: 9, message: { message_id: "c", chat: { id: "c" }, date: 1, text: "three" } }]);
  answers.push({ hang: true });
  const stop = new AbortController();
  const seen = [];
  for await (const u of bot.updates({ timeout: 1, signal: stop.signal })) {
    seen.push(u.message.text);
    if (seen.length === 3) setTimeout(() => stop.abort(), 50);
  }
  assert.deepEqual(seen, ["one", "two", "three"]);
  assert.deepEqual(calls.map((c) => json(c).offset), [0, 5, 10]);
});

test("commands", async () => {
  await bot.setMyCommands([["status", "How things are"], { command: "help" }]);
  assert.deepEqual(json(last()), { commands: [{ command: "status", description: "How things are" }, { command: "help", description: "" }] });
  ok([{ command: "status", description: "How things are" }]);
  assert.deepEqual(await bot.getMyCommands(), [{ command: "status", description: "How things are" }]);
  ok({ id: "b1", username: "meteo_bot", name: "Meteo", commands: [{ command: "now" }] });
  assert.deepEqual(await bot.getMe(), { id: "b1", username: "meteo_bot", name: "Meteo", about: "", commands: [{ command: "now", description: "" }] });
});

test("errors say why, and never the token", async () => {
  answers.push({ status: 403, payload: { error: "forbidden", message: "the user stopped this bot", reason: "bot_stopped" } });
  const stopped = await bot.sendMessage("c", "x").catch((e) => e);
  assert.ok(stopped instanceof DialogError);
  assert.deepEqual([stopped.status, stopped.code, stopped.reason, stopped.stopped], [403, "forbidden", "bot_stopped", true]);

  answers.push({ status: 429, payload: { error: "rate_limited", message: "slow down" }, headers: { "Retry-After": "12" } });
  const limited = await bot.sendMessage("c", "x").catch((e) => e);
  assert.deepEqual([limited.status, limited.code, limited.retryAfter, limited.stopped], [429, "rate_limited", 12, false]);

  answers.push({ status: 502, raw: "<html>bad gateway</html>" });
  const gateway = await bot.getMe().catch((e) => e);
  assert.deepEqual([gateway.status, gateway.code, gateway.retryAfter], [502, "http_error", undefined]);

  answers.push({ status: 200, raw: "[]" });
  const odd = await bot.getMe().catch((e) => e);
  assert.equal(odd.code, "bad_response");

  const nowhere = new Bot(TOKEN, { baseUrl: "http://127.0.0.1:1" });
  const down = await nowhere.getMe().catch((e) => e);
  assert.deepEqual([down.status, down.code], [0, "network"]);

  answers.push({ hang: true });
  const slow = await new Bot(TOKEN, { baseUrl: bot.baseUrl, timeoutMs: 100 }).getMe().catch((e) => e);
  assert.deepEqual([slow.status, slow.code], [0, "timeout"]);

  for (const e of [stopped, limited, gateway, odd, down, slow]) {
    assert.ok(!(inspect(e, { depth: 5 }) + e.stack + e.message).includes("SECRET"), e.code);
  }
  assert.ok(!inspect(bot, { depth: 5, showHidden: true }).includes("SECRET"));
  assert.ok(!JSON.stringify(bot).includes("SECRET"));
});

test("a token is required", () => {
  assert.throws(() => new Bot(""), TypeError);
});
