// Optional email delivery. Email is NOT required to run the gateway:
// if no SMTP service is configured, this module reports
// { configured: false } and the caller must show a clear "email not
// configured" notice instead of pretending a message was sent.
// When SMTP is configured, nodemailer is imported dynamically, so a
// deployment without SMTP never loads it and never fails on it.
// Secrets are never logged here.
export function mailerConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_FROM);
}

export async function sendMail({ to, subject, text }) {
  if (!mailerConfigured()) {
    return { configured: false, sent: false };
  }
  const nodemailer = (await import('nodemailer')).default;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
  return { configured: true, sent: true };
}
