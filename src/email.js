// Sending email: sign-in codes and invitations, through Resend (https://resend.com/docs/api-reference/emails/send-email).
// RESEND_API_KEY is a secret; EMAIL_FROM (a var) must be at a domain verified in Resend.
//
// For local development, EMAIL_DEV_LOG=1 in .dev.vars prints the email to the console instead of sending it.

export async function sendEmail(env, { to, subject, text }) {
  if (env.EMAIL_DEV_LOG === '1') {
    console.log(`email to ${to}: ${subject}\n${text}`);
    return true;
  }
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    console.error('email: RESEND_API_KEY or EMAIL_FROM is not set');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text }),
    });
    if (!res.ok) console.error(`email: Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.ok;
  } catch (err) {
    console.error('email:', err.message);
    return false;
  }
}

export function codeEmail(code, where) {
  return {
    subject: `${code} is your mcstats sign-in code`,
    text: `Your sign-in code for ${where} is:\n\n    ${code}\n\nIt works for 10 minutes. If you didn't ask for it, you can ignore this email.\n`,
  };
}
