/**
 * Minimal SMTP client, sufficient for transactional alert/login mail through
 * any standard relay (implicit TLS on 465 or STARTTLS on 587/25, AUTH PLAIN
 * or LOGIN). Dependency-free by design; if you need DKIM signing or bounce
 * handling, point this at a relay that does it.
 */
import net from "node:net";
import tls from "node:tls";

const CRLF = "\r\n";

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    socket.on("data", (d) => {
      this.buffer += d.toString("utf8");
      this.drain();
    });
  }

  drain() {
    // Responses end with "<code><space>" on the final line (multiline uses "-").
    while (this.waiters.length) {
      const idx = this.buffer.search(/^\d{3} [^\n]*\r?\n/m);
      if (idx === -1) return;
      const end = this.buffer.indexOf("\n", idx) + 1;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const code = Number(block.match(/^(\d{3}) /m)[1]);
      this.waiters.shift()({ code, text: block.trim() });
    }
  }

  read() {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.drain();
    });
  }

  async cmd(line, ...okCodes) {
    this.socket.write(line + CRLF);
    const res = await this.read();
    if (!okCodes.includes(res.code)) {
      throw new Error(`SMTP: "${line.split(" ")[0]}" failed: ${res.text.slice(0, 200)}`);
    }
    return res;
  }
}

function dotStuff(body) {
  return body.replace(/\r?\n/g, CRLF).replace(/^\./gm, "..");
}

/**
 * Send one message. `smtp` config: { host, port?, secure?, user?, pass?, from, to }.
 * `to` may be a string or array. Fails with a descriptive Error; callers treat
 * alerting as best-effort.
 */
export async function sendMail(smtp, { to, subject, text }) {
  const port = smtp.port ?? 587;
  const secure = smtp.secure ?? port === 465;
  const recipients = Array.isArray(to) ? to : [to];
  const hello = "server-tools";

  const plain = await new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect({ host: smtp.host, port, servername: smtp.host }, () => resolve(s))
      : net.connect({ host: smtp.host, port }, () => resolve(s));
    s.setTimeout(20_000, () => s.destroy(new Error("SMTP timeout")));
    s.on("error", reject);
  });

  let session = new SmtpSession(plain);
  const greet = await session.read();
  if (greet.code !== 220) throw new Error(`SMTP greeting failed: ${greet.text.slice(0, 200)}`);
  const ehlo = await session.cmd(`EHLO ${hello}`, 250);

  let socket = plain;
  if (!secure && /STARTTLS/i.test(ehlo.text)) {
    await session.cmd("STARTTLS", 220);
    socket = await new Promise((resolve, reject) => {
      const t = tls.connect({ socket: plain, servername: smtp.host }, () => resolve(t));
      t.on("error", reject);
    });
    session = new SmtpSession(socket);
    await session.cmd(`EHLO ${hello}`, 250);
  }

  if (smtp.user && smtp.pass) {
    const token = Buffer.from(`\0${smtp.user}\0${smtp.pass}`).toString("base64");
    await session.cmd(`AUTH PLAIN ${token}`, 235);
  }

  await session.cmd(`MAIL FROM:<${smtp.from}>`, 250);
  for (const rcpt of recipients) await session.cmd(`RCPT TO:<${rcpt}>`, 250, 251);
  await session.cmd("DATA", 354);

  const headers = [
    `From: ${smtp.from}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@server-tools>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
  ].join(CRLF);
  socket.write(headers + CRLF + dotStuff(text) + CRLF + "." + CRLF);
  const final = await session.read();
  if (final.code !== 250) throw new Error(`SMTP DATA failed: ${final.text.slice(0, 200)}`);
  try {
    await session.cmd("QUIT", 221);
  } catch {
    // Some servers close abruptly after QUIT; the message is already accepted.
  }
  socket.destroy();
}
