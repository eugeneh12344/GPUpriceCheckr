function errorMessage(error) {
  return [error?.message, error?.cause?.message].filter(Boolean).join(": ") || "Unknown email delivery error";
}

export async function sendEmail({ subject, text, html, idempotencyKey }) {
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
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {})
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
      if (response.ok) return { status: "sent", id: data.id };
      const error = new Error(data.message || `Resend ${response.status}`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  throw new Error(`Resend delivery failed after 3 attempts: ${errorMessage(lastError)}`);
}
