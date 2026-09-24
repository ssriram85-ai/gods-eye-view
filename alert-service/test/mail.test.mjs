import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { buildMessage, sendMail } from '../src/mail.mjs';

/** A fake SMTP server that records the dialogue and the message body. */
function fakeSmtp({ rejectRecipient = '' } = {}) {
  const seen = { commands: [], data: '' };
  const server = createServer((socket) => {
    let inData = false;
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (inData) {
        seen.data += text;
        if (seen.data.endsWith('\r\n.\r\n')) {
          inData = false;
          socket.write('250 queued\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        seen.commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-fake\r\n250 AUTH LOGIN PLAIN\r\n');
        else if (line === 'AUTH LOGIN') socket.write('334 VXNlcm5hbWU6\r\n');
        else if (line === Buffer.from('user@example').toString('base64')) socket.write('334 UGFzc3dvcmQ6\r\n');
        else if (line === Buffer.from('app-pass').toString('base64')) socket.write('235 ok\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 ok\r\n');
        else if (line.startsWith('RCPT TO')) socket.write(line.includes(rejectRecipient || '\u0000') ? '550 no such user\r\n' : '250 ok\r\n');
        else if (line === 'DATA') ((inData = true), socket.write('354 go\r\n'));
        else if (line === 'QUIT') ((socket.write('221 bye\r\n'), socket.end()));
        else socket.write('500 what\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('the message is multipart with base64 text and HTML parts and an encoded subject', () => {
  const msg = buildMessage({ from: 'GEV <a@example>', to: ['b@example'], subject: 'OMR · week 39', text: 'hello', html: '<p>hello</p>', date: new Date(0), id: 'x' });
  assert.match(msg, /^From: GEV <a@example>\r\nTo: b@example\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(msg, /Content-Type: multipart\/alternative; boundary="=_gev_/);
  assert.match(msg, /Content-Type: text\/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nPHA\+aGVsbG88L3A\+/);
  assert.match(msg, /Message-ID: <x@gev-alerts>/);
});

test('sendMail speaks SMTP with AUTH LOGIN and delivers to the accepted recipients', async () => {
  const { server, port, seen } = await fakeSmtp({ rejectRecipient: 'gone@example' });
  try {
    const result = await sendMail({ host: '127.0.0.1', port, user: 'user@example', pass: 'app-pass', from: 'GEV <user@example>',
      to: ['boss@example', 'gone@example'], subject: 'weekly', html: '<b>report</b>', mode: 'plain', connect: () => connect({ host: '127.0.0.1', port }) });
    assert.deepEqual(result.accepted, ['boss@example']);
    assert.deepEqual(seen.commands.filter((c) => /^(EHLO|AUTH|MAIL|RCPT|DATA|QUIT)/.test(c)),
      ['EHLO gev-alerts', 'AUTH LOGIN', 'MAIL FROM:<user@example>', 'RCPT TO:<boss@example>', 'RCPT TO:<gone@example>', 'DATA', 'QUIT']);
    assert.match(seen.data, /Subject: weekly/);
    assert.match(seen.data, /To: boss@example, gone@example/);
  } finally {
    server.close();
  }
});

test('a rejected login is reported as an error, not swallowed', async () => {
  const { server, port } = await fakeSmtp();
  try {
    await assert.rejects(
      sendMail({ host: '127.0.0.1', port, user: 'user@example', pass: 'wrong', from: 'a@example', to: 'b@example', subject: 's', html: '<p/>', mode: 'plain', connect: () => connect({ host: '127.0.0.1', port }) }),
      /password -> 500/,
    );
  } finally {
    server.close();
  }
});
