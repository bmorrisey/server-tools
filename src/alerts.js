/**
 * Alert routing. Channels are optional and independent; a channel that is not
 * configured is skipped, and a channel that errors is logged but never takes
 * the agent down. Every alert is also appended to the events history so the
 * dashboard shows it even with zero channels configured.
 *
 * Channels:
 *   smtp     plain-text email (src/smtp.js)
 *   webhook  JSON POST { title, body, level, source, ts } - works as-is with
 *            generic receivers and ntfy; a { "format": "discord" } option
 *            wraps it as { content } for Discord/Slack-compatible hooks.
 */
import { sendMail } from "./smtp.js";
import { logger } from "./log.js";
import { isoNow } from "./util.js";

const log = logger("alerts");

export class Alerter {
  constructor(config, store) {
    this.config = config.alerts ?? {};
    this.store = store;
  }

  /** level: "fail" | "recover" | "info" */
  async send({ title, body, level = "info", source = "server-tools" }) {
    this.store?.append("alerts", { title, body, level, source });
    const tasks = [];
    if (this.config.smtp) tasks.push(this.viaSmtp({ title, body, level }));
    if (this.config.webhook) tasks.push(this.viaWebhook({ title, body, level, source }));
    if (!tasks.length) {
      log.info(`(no alert channels configured) ${title}`);
      return;
    }
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === "rejected") log.warn(`alert channel failed: ${r.reason?.message ?? r.reason}`);
    }
  }

  async viaSmtp({ title, body, level }) {
    const prefix = level === "fail" ? "[ALERT]" : level === "recover" ? "[RECOVERED]" : "[INFO]";
    await sendMail(this.config.smtp, {
      to: this.config.smtp.to,
      subject: `${prefix} ${title}`,
      text: `${body}\n\n-- server-tools at ${isoNow()}`,
    });
  }

  async viaWebhook({ title, body, level, source }) {
    const { url, format, headers = {} } = this.config.webhook;
    const payload =
      format === "discord"
        ? { content: `**${level === "fail" ? "ALERT" : level.toUpperCase()}: ${title}**\n${body}` }
        : { title, body, level, source, ts: isoNow() };
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }
}
