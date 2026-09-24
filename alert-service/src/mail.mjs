/**
 * A small SMTP client, enough to send one HTML report through Gmail,
 * SendGrid or any host that accepts AUTH LOGIN over TLS (465) or STARTTLS
 * (587). Dependency-free like the rest of the service. Bodies go base64 so
 * line length and dot-stuffing never matter.
 */
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (s) => {
  const m = /<([^>]+)>/.exec(String(s));
  return (m ? m[1] : String(s)).trim();
};

/** Build the RFC 5322 message: multipart/alternative with text and HTML parts. */
export function buildMessage({ from, to, subject, text, html, date = new Date(), id = randomBytes(8).toString('hex') }) {
  const boundary = `=_gev_${randomBytes(6).toString('hex')}`;
  const recipients = Array.isArray(to) ? to : [to];
  const lines = [
    `From: ${from}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@gev-alerts>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text || html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

/**
 * Send one message. `mode` is 'tls' (implicit, port 465), 'starttls' (587)
 * or 'plain' (tests only). Resolves with the accepted recipients.
 */
export async function sendMail({ host, port = 465, user, pass, from, to, subject, text, html, mode, timeoutMs = 30_000, connect }) {
  if (!host || !from || !to?.length) throw new Error('mail: host, from and to are required');
  const recipients = (Array.isArray(to) ? to : [to]).map(addr);
  const kind = mode || (port === 587 ? 'starttls' : 'tls');
  let socket = connect ? await connect() : kind === 'tls' ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error('mail: SMTP timed out')));

  let buffer = '';
  let waiter = null;
  const feed = (chunk) => {
    buffer += chunk.toString('utf8');
    const m = /^(\d{3})([ -])/m.exec(buffer);
    if (!m) return;
    // A reply ends at the first line whose 4th char is a space.
    const done = /^\d{3} .*\r?\n/m.exec(buffer);
    if (!done || !waiter) return;
    const end = done.index + done[0].length;
    const reply = buffer.slice(0, end);
    buffer = buffer.slice(end);
    const w = waiter;
    waiter = null;
    w.resolve({ code: Number(reply.slice(0, 3)), text: reply });
  };
  const attach = (s) => {
    s.on('data', feed);
    s.on('error', (e) => waiter?.reject(e));
    s.on('close', () => waiter?.reject(new Error('mail: connection closed')));
  };
  attach(socket);
  const reply = () => new Promise((resolve, reject) => (waiter = { resolve, reject }));
  const expect = async (codes, label) => {
    const r = await reply();
    if (!codes.includes(r.code)) throw new Error(`mail: ${label} -> ${r.text.trim().split('\n').pop()}`);
    return r;
  };
  const send = (line) => socket.write(line + '\r\n');
  const cmd = (line, codes, label = line.split(' ')[0]) => (send(line), expect(codes, label));

  try {
    await expect([220], 'greeting');
    await cmd('EHLO gev-alerts', [250]);
    if (kind === 'starttls') {
      await cmd('STARTTLS', [220]);
      socket.removeAllListeners('data');
      socket = tlsConnect({ socket, servername: host });
      attach(socket);
      await new Promise((resolve, reject) => socket.once('secureConnect', resolve).once('error', reject));
      await cmd('EHLO gev-alerts', [250]);
    }
    if (user) {
      await cmd('AUTH LOGIN', [334]);
      await cmd(b64(user), [334], 'username');
      await cmd(b64(pass || ''), [235], 'password');
    }
    await cmd(`MAIL FROM:<${addr(from)}>`, [250]);
    const accepted = [];
    for (const r of recipients) {
      const reply = await cmd(`RCPT TO:<${r}>`, [250, 251, 550, 553], 'RCPT');
      if (reply.code < 300) accepted.push(r);
    }
    if (!accepted.length) throw new Error('mail: no recipient accepted');
    await cmd('DATA', [354]);
    socket.write(buildMessage({ from, to: recipients, subject, text, html }) + '\r\n.\r\n');
    await expect([250], 'message');
    await cmd('QUIT', [221]).catch(() => {}); // the message is already queued; a rude hangup is not a failure
    return { accepted };
  } finally {
    socket.end();
    socket.destroy();
  }
}
