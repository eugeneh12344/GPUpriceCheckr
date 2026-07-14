export async function sendEmail({ subject, text, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.REPORT_TO_EMAIL;
  const from = process.env.REPORT_FROM_EMAIL;

  if (!apiKey || !to || !from) {
    return {
      status: "skipped",
      reason: "RESEND_API_KEY, REPORT_TO_EMAIL, and REPORT_FROM_EMAIL are required to send email."
    };
  }

  const timeoutMs = Number(process.env.EMAIL_TIMEOUT_MS || 30_000);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: to.split(",").map((email) => email.trim()).filter(Boolean),
      subject,
      text,
      html
    }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend ${response.status}`);
  return { status: "sent", id: data.id };
}
