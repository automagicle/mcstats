// Sending email: account codes and invitations, through Resend (https://resend.com/docs/api-reference/emails/send-email).
// RESEND_API_KEY is a secret; EMAIL_FROM (a var) must be at a domain verified in Resend.
//
// For local development, EMAIL_DEV_LOG=1 in .dev.vars prints the email to the console instead of sending it.

export async function sendEmail(env, { to, subject, text, html }) {
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
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, text, ...(html && { html }) }),
    });
    if (!res.ok) console.error(`email: Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.ok;
  } catch (err) {
    console.error('email:', err.message);
    return false;
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The link in a code email carries the same code, with the address it's for, after the # of /account
// (public/site.js fills the form in with them). What follows a # is never sent to a server, so the code
// isn't in anyone's logs, and a mail scanner that fetches the link uses nothing up.
export const signInLink = (origin, path, email, code) => `${origin}${path}#${new URLSearchParams({ email, code })}`;

// The code that proves an email address, to make an account or set a new password (src/account.js).
export function accountCodeEmail(code, link) {
  const what = 'Use it to create your mcstats account, or to set a new password if you already have one.';
  const ends = 'for 10 minutes, once. If you didn’t ask for it, you can ignore this email: nothing changes without the code.';
  return {
    subject: `${code} is your mcstats code`,
    text: `Your mcstats code is:\n\n    ${code}\n\n${what}\n\nOr open this link to carry on without typing it:\n\n    ${link}\n\nEither works ${ends}\n`,
    html: `<div style="font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1a1d21">`
      + `<p>Your mcstats code is:</p>`
      + `<p style="font:700 28px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:4px;margin:16px 0">${esc(code)}</p>`
      + `<p>${what}</p>`
      + `<p style="margin:16px 0"><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#3d8a26;color:#ffffff;font-weight:600;text-decoration:none">Choose a password</a></p>`
      + `<p style="color:#5b6470;font-size:14px">Either works ${ends}</p></div>`,
  };
}

export function passwordChangedEmail(accountUrl) {
  return {
    subject: 'Your mcstats password was changed',
    text: `The password of your mcstats account was just changed, and it was signed out everywhere else.\n\nIf that was you, there’s nothing to do.\n\nIf it wasn’t, open ${accountUrl}, choose "Forgot password" and set a new one: that signs out whoever changed it.\n`,
  };
}
