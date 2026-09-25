const nodemailer = require('nodemailer');

function isSmtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!isSmtpConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendVerificationEmail(toEmail, username, token) {
  const baseUrl = process.env.APP_URL || 'http://localhost:3000';
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;

  const subject = 'Verify your Thredy account';
  const text = `Hi ${username},\n\nWelcome to Thredy! Please verify your email by opening this link:\n${verifyUrl}\n\nThis link expires in 24 hours. If you didn't create this account, you can ignore this email.`;
  const html = `<p>Hi ${username},</p><p>Welcome to Thredy! Please verify your email by clicking the link below:</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>This link expires in 24 hours. If you didn't create this account, you can ignore this email.</p>`;

  const t = getTransporter();
  if (!t) {
    // No SMTP configured (typical for local dev / first-time setup) — log it instead so
    // verification is still testable without needing a mail provider yet.
    console.log('\n[Thredy] SMTP not configured — verification link (would have been emailed):');
    console.log(`  To: ${toEmail}`);
    console.log(`  ${verifyUrl}\n`);
    return { delivered: false, verifyUrl };
  }

  await t.sendMail({
    from: process.env.SMTP_FROM || `"Thredy" <no-reply@thredy.local>`,
    to: toEmail,
    subject,
    text,
    html,
  });
  return { delivered: true };
}

module.exports = { sendVerificationEmail, isSmtpConfigured };
