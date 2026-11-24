import { connect } from 'cloudflare:sockets';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64Text(value) {
  return base64(encoder.encode(value));
}

function base64Lines(value) {
  const encoded = base64Text(value);
  return encoded.match(/.{1,76}/g)?.join('\r\n') || '';
}

function assertSafeHeader(value, label) {
  if (typeof value !== 'string' || /[\r\n<>]/.test(value)) {
    throw new Error(`Invalid ${label} for Gmail SMTP.`);
  }
}

function smtpChannel(socket) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  let pending = '';
  let ended = false;

  async function readLine() {
    while (!pending.includes('\r\n')) {
      if (ended) throw new Error('Gmail SMTP closed the connection unexpectedly.');
      const { value, done } = await reader.read();
      if (done) {
        ended = true;
        continue;
      }
      pending += decoder.decode(value, { stream: true });
    }
    const newline = pending.indexOf('\r\n');
    const line = pending.slice(0, newline);
    pending = pending.slice(newline + 2);
    return line;
  }

  return {
    release() {
      reader.releaseLock();
      writer.releaseLock();
    },
    async write(value) {
      await writer.write(encoder.encode(value));
    },
    async response() {
      const lines = [];
      let code = null;
      while (true) {
        const line = await readLine();
        lines.push(line);
        const match = line.match(/^(\d{3})([ -])/);
        if (!match) throw new Error('Gmail SMTP returned an invalid response.');
        code = Number(match[1]);
        if (match[2] === ' ') break;
      }
      return { code, text: lines.join('\n') };
    }
  };
}

async function expect(channel, command, expectedCodes) {
  if (command) await channel.write(`${command}\r\n`);
  const response = await channel.response();
  if (!expectedCodes.includes(response.code)) {
    // Do not include the server's full response; it can contain account details.
    throw new Error(`Gmail SMTP command failed with response ${response.code}.`);
  }
  return response;
}

function makeMimeMessage(sender, recipient, message, messageId) {
  assertSafeHeader(sender, 'sender address');
  assertSafeHeader(recipient, 'recipient address');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    throw new Error('Gmail SMTP requires valid sender and recipient email addresses.');
  }
  const boundary = `myplan_${crypto.randomUUID().replaceAll('-', '')}`;
  const subject = `=?UTF-8?B?${base64Text(message.subject || 'MyPlan daily digest')}?=`;
  const plain = String(message.text || '');
  const html = String(message.html || '');
  return [
    `From: MyPlan <${sender}>`,
    `To: ${recipient}`,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(plain),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(html),
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

async function stableMessageId(idempotencyKey) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(idempotencyKey));
  const token = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return `${token}@myplan.local`;
}

export async function sendGmailSmtp({ address, appPassword, recipient, message, idempotencyKey, beforeSend }) {
  if (!address || !appPassword) throw new Error('Gmail sender address and App Password are not configured.');
  const cleanPassword = String(appPassword).replace(/\s/g, '');
  const messageId = await stableMessageId(idempotencyKey);
  const mime = makeMimeMessage(address, recipient, message, messageId)
    .replace(/^\./gm, '..');

  let socket;
  try {
    socket = connect({ hostname: 'smtp.gmail.com', port: 587 }, { secureTransport: 'starttls' });
    await socket.opened;
    let channel = smtpChannel(socket);
    await expect(channel, null, [220]);
    await expect(channel, 'EHLO myplan.local', [250]);
    await expect(channel, 'STARTTLS', [220]);
    channel.release();

    socket = socket.startTls();
    await socket.opened;
    channel = smtpChannel(socket);
    await expect(channel, 'EHLO myplan.local', [250]);
    await expect(channel, 'AUTH LOGIN', [334]);
    await expect(channel, base64Text(address), [334]);
    await expect(channel, base64Text(cleanPassword), [235]);
    await expect(channel, `MAIL FROM:<${address}>`, [250]);
    await expect(channel, `RCPT TO:<${recipient}>`, [250, 251]);
    if (beforeSend && !(await beforeSend())) {
      await expect(channel, 'RSET', [250]);
      await expect(channel, 'QUIT', [221]);
      channel.release();
      return null;
    }
    await expect(channel, 'DATA', [354]);
    await channel.write(`${mime.replace(/\r?\n/g, '\r\n')}\r\n.\r\n`);
    await expect(channel, null, [250]);
    await expect(channel, 'QUIT', [221]);
    channel.release();
    return messageId;
  } finally {
    if (socket) {
      try { await socket.close(); } catch { }
    }
  }
}
