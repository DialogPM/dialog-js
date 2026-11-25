/** The official Dialog server. Pass another one to `Bot` for a self-hosted server. */
export const DEFAULT_BASE_URL = "https://chat.dialog.pm";

const USER_AGENT = "dialog-bot-js/0.1.0";
// getUpdates waits on the server for at most 50 seconds.
const MAX_POLL_SECONDS = 50;

/**
 * The server refused a call, or could not be reached.
 *
 * `status` is the HTTP status (0 when there was no answer), `code` the server's error code
 * (`forbidden`, `rate_limited`...) and `reason`, when present, says why in a way a program
 * can act on: `chat_not_found`, `bot_stopped` (the user stopped the bot), `bot_disabled`.
 */
export class DialogError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  /** Seconds to wait before trying again, on a 429. */
  readonly retryAfter?: number;

  constructor(status: number, code: string, message: string, reason?: string, retryAfter?: number) {
    super(`${status} ${code}: ${message}${reason ? ` (${reason})` : ""}`);
    this.name = "DialogError";
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }

  /** The user stopped the bot: nothing can be sent to this chat until they start it again. */
  get stopped(): boolean {
    return this.reason === "bot_stopped";
  }
}

/** A command the apps offer after "/" in the chat with the bot. */
export interface Command {
  command: string;
  description?: string;
}

export interface BotInfo {
  id: string;
  username: string;
  name: string;
  about: string;
  commands: Command[];
}

/** A button under a message: it has either `data` or `url`. Use `button.callback` or `button.link`. */
export type Button = { text: string; data: string; url?: undefined } | { text: string; url: string; data?: undefined };

/** Buttons: rows of buttons, or a flat list, which is one row. */
export type Buttons = ReadonlyArray<Button | ReadonlyArray<Button>>;

export const button = {
  /** Pressing it sends `data` (at most 64 bytes) back to the bot as a callback query. */
  callback: (text: string, data: string): Button => ({ text, data }),
  /** Pressing it opens `url` (https only), after the app shows the address. */
  link: (text: string, url: string): Button => ({ text, url }),
};

export interface SendOptions {
  buttons?: Buttons;
  /** Deliver without a sound. */
  silent?: boolean;
}

export interface PhotoOptions extends SendOptions {
  caption?: string;
}

export interface SentMessage {
  messageId: string;
  chatId: string;
  date: number;
}

/** Someone wrote to the bot. The first message of a chat is "/start". */
export interface Message {
  messageId: string;
  chatId: string;
  date: number;
  text: string;
  /** The command of the message without the slash ("/status now" -> "status"), if any. */
  command?: string;
}

/** Someone pressed a button of the message `messageId`. */
export interface CallbackQuery {
  chatId: string;
  messageId: string;
  data: string;
  date: number;
}

/** Someone stopped the bot: it can no longer write to `chatId`. */
export interface ChatStopped {
  chatId: string;
  date: number;
}

/** One event for the bot: exactly one of `message`, `callbackQuery`, `chatStopped` is set. */
export interface Update {
  updateId: number;
  chatId?: string;
  message?: Message;
  callbackQuery?: CallbackQuery;
  chatStopped?: ChatStopped;
}

export interface BotOptions {
  /** The Dialog server the bot lives on; the official one by default. */
  baseUrl?: string;
  /** How long an ordinary call may take, in milliseconds (30 000 by default). */
  timeoutMs?: number;
  /** Another `fetch` than the global one. */
  fetch?: typeof fetch;
}

export interface GetUpdatesOptions {
  /** The last `updateId` handled plus one; updates below it are confirmed and deleted. */
  offset?: number;
  limit?: number;
  /** Seconds (at most 50) to wait for an update instead of returning an empty list. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface UpdatesOptions {
  /** Seconds each long poll waits (30 by default, at most 50). */
  timeout?: number;
  /** Aborting it ends the loop quietly. */
  signal?: AbortSignal;
}

type Json = Record<string, any>;

function rows(buttons?: Buttons): Json[][] | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  // A flat list of buttons is one row.
  const list = buttons.every((b) => !Array.isArray(b)) ? [buttons as ReadonlyArray<Button>] : buttons;
  return list.map((row) =>
    (Array.isArray(row) ? (row as ReadonlyArray<Button>) : [row as Button]).map((b) => {
      const data = typeof b.data === "string";
      if (data === (typeof b.url === "string")) throw new TypeError("a button has either data or url");
      return data ? { text: b.text, data: b.data } : { text: b.text, url: b.url };
    }),
  );
}

function commandOf(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const head = text.slice(1).trim().split(/\s+/)[0];
  return head ? head.toLowerCase() : undefined;
}

function commands(raw: unknown): Command[] {
  return Array.isArray(raw) ? raw.map((c) => ({ command: String(c.command), description: String(c.description ?? "") })) : [];
}

function sent(r: Json): SentMessage {
  return { messageId: String(r.message_id), chatId: String(r.chat?.id ?? ""), date: Number(r.date ?? 0) };
}

function update(raw: Json): Update {
  const u: Update = { updateId: Number(raw.update_id) };
  const chat = (part: Json) => String(part.chat?.id ?? "");
  const { message: m, callback_query: c, chat_stopped: s } = raw;
  if (m) {
    const text = String(m.text ?? "");
    u.message = { messageId: String(m.message_id ?? ""), chatId: chat(m), date: Number(m.date ?? 0), text, command: commandOf(text) };
  }
  if (c) u.callbackQuery = { chatId: chat(c), messageId: String(c.message_id ?? ""), data: String(c.data ?? ""), date: Number(c.date ?? 0) };
  if (s) u.chatStopped = { chatId: chat(s), date: Number(s.date ?? 0) };
  u.chatId = (u.message ?? u.callbackQuery ?? u.chatStopped)?.chatId;
  return u;
}

/** A bot, by its token. */
export class Bot {
  // Private, so logging a Bot never shows the token.
  readonly #token: string;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(token: string, options: BotOptions = {}) {
    if (!token) throw new TypeError("a bot token is required");
    this.#token = token;
    this.#base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TypeError("no fetch in this runtime: pass one in options.fetch");
    this.#fetch = f;
  }

  /** The server this bot talks to. */
  get baseUrl(): string {
    return this.#base;
  }

  /** The bot itself: a quick way to check the token. */
  async getMe(): Promise<BotInfo> {
    const r = await this.#call("getMe", {});
    return { id: String(r.id), username: String(r.username), name: String(r.name), about: String(r.about ?? ""), commands: commands(r.commands) };
  }

  /**
   * Sends text (at most 4096 characters). `*bold*`, `_italic_` and `` `code` `` are rendered.
   *
   * Rejects with a `DialogError` whose `stopped` is true when the user stopped the bot.
   */
  async sendMessage(chatId: string, text: string, options: SendOptions = {}): Promise<SentMessage> {
    const params: Json = { chat_id: chatId, text };
    const r = rows(options.buttons);
    if (r) params.buttons = r;
    if (options.silent) params.silent = true;
    return sent(await this.#call("sendMessage", params));
  }

  /**
   * Sends a picture: the bytes of a JPEG, PNG, GIF or WebP (at most 10 MiB), a `Blob`, or,
   * under Node, Bun and Deno, a path to a file.
   */
  async sendPhoto(chatId: string, photo: Uint8Array | ArrayBuffer | Blob | string, options: PhotoOptions = {}): Promise<SentMessage> {
    let body: Uint8Array | ArrayBuffer | Blob;
    if (typeof photo === "string") {
      const { readFile } = await import("node:fs/promises");
      body = await readFile(photo);
    } else {
      body = photo;
    }
    const query = new URLSearchParams({ chat_id: chatId });
    if (options.caption) query.set("caption", options.caption);
    const r = rows(options.buttons);
    if (r) query.set("buttons", JSON.stringify(r));
    if (options.silent) query.set("silent", "true");
    return sent(await this.#request("sendPhoto", body as BodyInit, "image/*", query, this.#timeoutMs * 2));
  }

  /**
   * What happened since `offset`: messages, button presses, stops. `updates()` does the
   * bookkeeping of `offset` for you.
   */
  async getUpdates(options: GetUpdatesOptions = {}): Promise<Update[]> {
    const timeout = Math.max(0, Math.min(Math.trunc(options.timeout ?? 0), MAX_POLL_SECONDS));
    const body = JSON.stringify({ offset: options.offset ?? 0, limit: options.limit ?? 100, timeout });
    const r = await this.#request("getUpdates", body, "application/json", undefined, this.#timeoutMs + timeout * 1000, options.signal);
    return Array.isArray(r) ? r.map(update) : [];
  }

  /**
   * Yields updates forever (long polling), confirming each one once it was handled.
   *
   *     for await (const update of bot.updates()) {
   *       if (update.message) await bot.sendMessage(update.message.chatId, "Got it");
   *     }
   */
  async *updates(options: UpdatesOptions = {}): AsyncGenerator<Update, void, void> {
    let offset = 0;
    const { signal } = options;
    while (!signal?.aborted) {
      let batch: Update[];
      try {
        batch = await this.getUpdates({ offset, timeout: options.timeout ?? 30, signal });
      } catch (e) {
        if (signal?.aborted) return;
        throw e;
      }
      for (const u of batch) {
        yield u;
        offset = u.updateId + 1;
      }
    }
  }

  /** The commands the apps offer after "/" (at most 50), as objects or `[command, description]` pairs. */
  async setMyCommands(list: ReadonlyArray<Command | readonly [string, string?]>): Promise<void> {
    const items = list.map((c) => {
      const [command, description] = Array.isArray(c) ? (c as readonly [string, string?]) : [(c as Command).command, (c as Command).description];
      return { command, description: description ?? "" };
    });
    await this.#call("setMyCommands", { commands: items });
  }

  async getMyCommands(): Promise<Command[]> {
    return commands(await this.#call("getMyCommands", {}));
  }

  #call(method: string, params: Json): Promise<any> {
    return this.#request(method, JSON.stringify(params), "application/json", undefined, this.#timeoutMs);
  }

  async #request(method: string, body: BodyInit, contentType: string, query: URLSearchParams | undefined, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    let url = `${this.#base}/bot/${encodeURIComponent(this.#token)}/${method}`;
    if (query) url += `?${query}`;
    const limit = AbortSignal.timeout(timeoutMs);
    let res: Response;
    let payload: unknown;
    try {
      res = await this.#fetch(url, {
        method: "POST",
        headers: { "Content-Type": contentType, "User-Agent": USER_AGENT },
        body,
        signal: signal ? AbortSignal.any([signal, limit]) : limit,
      });
      const text = await res.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      // Never the cause's own text: it can carry the address, and the address carries the token.
      throw new DialogError(0, limit.aborted ? "timeout" : "network", limit.aborted ? `${method} took too long` : `${method} could not reach the server`);
    }
    if (!res.ok) {
      const b: Json = payload && typeof payload === "object" ? (payload as Json) : {};
      const retry = Number(res.headers.get("Retry-After"));
      throw new DialogError(
        res.status,
        String(b.error || "http_error"),
        String(b.message || res.statusText || ""),
        typeof b.reason === "string" ? b.reason : undefined,
        res.headers.has("Retry-After") && Number.isFinite(retry) ? retry : undefined,
      );
    }
    if (!payload || typeof payload !== "object" || (payload as Json).ok !== true) {
      throw new DialogError(200, "bad_response", "the server's answer is not a Bot API result");
    }
    return (payload as Json).result;
  }
}
