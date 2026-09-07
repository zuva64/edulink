const nodemailer = require('nodemailer');
let transport;

function smtpTransport() {
  if (!transport) {
    const host = process.env.SMTP_HOST;
    const port = Number(process.env.SMTP_PORT || 587);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Сервис отправки e-mail не настроен');
    const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
    const secure = process.env.SMTP_SECURE === 'true';
    transport = nodemailer.createTransport({
      host, port, secure, requireTLS: !local && !secure,
      ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } } : {}),
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      disableFileAccess: true, disableUrlAccess: true
    });
  }
  return transport;
}

async function sendOtp(email, otp, purpose) {
  const provider = process.env.MAIL_PROVIDER || (process.env.SMTP_HOST ? 'smtp' : 'resend');
  const from = process.env.EMAIL_FROM;
  const subject = purpose === 'register' ? 'Подтверждение регистрации EduLink' : 'Восстановление пароля EduLink';
  const text = `Ваш одноразовый код EduLink: ${otp}\nКод действует 10 минут. Никому его не сообщайте.`;
  const html = `<p>Ваш одноразовый код EduLink:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${otp}</p><p>Код действует 10 минут. Никому его не сообщайте.</p>`;
  if (!from || (provider === 'resend' && !process.env.RESEND_API_KEY)) {
    if (process.env.ALLOW_DEV_OTP === 'true' && process.env.NODE_ENV !== 'production') return { devOtp: otp };
    throw new Error('Сервис отправки e-mail не настроен');
  }
  try {
    if (provider === 'smtp') {
      const result = await smtpTransport().sendMail({ from, to: email, subject, text, html });
      if (!result.accepted?.length || result.rejected?.length) throw new Error('SMTP rejected recipient');
    } else if (provider === 'resend') {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [email], subject, text, html })
      });
      if (!r.ok) throw new Error('Mail provider rejected request');
    } else throw new Error('Unknown mail provider');
  } catch (error) {
    console.error('Mail delivery failed:', provider, error.code || 'delivery_error');
    throw new Error('Не удалось отправить e-mail');
  }
  return {};
}

module.exports = { sendOtp, smtpTransport };
