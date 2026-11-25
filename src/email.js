// Sending email: sign-in codes and invitations, through Resend (https://resend.com/docs/api-reference/emails/send-email).
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

// A sign-in link carries the same code as the email, with the address it's for, after the # of a page that
// signs in with them (public/site.js). What follows a # is never sent to a server, so the code isn't in
// anyone's logs, and a mail scanner that fetches the link uses nothing up: only the page's script signs in.
export const signInLink = (origin, path, email, code) => `${origin}${path}#${new URLSearchParams({ email, code })}`;

export function codeEmail(code, where, link) {
  const ends = 'for 10 minutes, once. If you didn’t ask for it, you can ignore this email.';
  return {
    subject: `${code} is your mcstats sign-in code`,
    text: link
      ? `Your sign-in code for ${where} is:\n\n    ${code}\n\nOr open this link to sign in without typing it:\n\n    ${link}\n\nEither works ${ends}\n`
      : `Your sign-in code for ${where} is:\n\n    ${code}\n\nIt works ${ends}\n`,
    ...(link && {
      html: `<div style="font:16px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1a1d21">`
        + `<p>Your sign-in code for ${esc(where)} is:</p>`
        + `<p style="font:700 28px/1.2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:4px;margin:16px 0">${esc(code)}</p>`
        + `<p>Or sign in without typing it:</p>`
        + `<p style="margin:16px 0"><a href="${esc(link)}" style="display:inline-block;padding:10px 18px;background:#3d8a26;color:#ffffff;font-weight:600;text-decoration:none">Sign in to ${esc(where)}</a></p>`
        + `<p style="color:#5b6470;font-size:14px">Either works ${ends}</p></div>`,
    }),
  };
}
