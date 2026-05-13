import https from "https";

const TERMII_API_KEY = process.env.TERMII_API_KEY;
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || "VibePulse";
const TERMII_BASE_URL = "https://api.ng.termii.com";

// Normalize Nigerian phone numbers to E.164 (+234...)
// Handles: 08012345678 → +2348012345678, +2348012345678 → +2348012345678, 2348012345678 → +2348012345678
export function normalizeNigerianPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");

  if (digits.startsWith("234") && digits.length >= 13) {
    return `+${digits}`;
  }
  if (digits.startsWith("0") && digits.length === 11) {
    return `+234${digits.slice(1)}`;
  }
  if (!digits.startsWith("234") && digits.length === 10) {
    return `+234${digits}`;
  }
  return `+${digits}`;
}

export async function sendNigeriaSMS(to: string, body: string): Promise<void> {
  if (!TERMII_API_KEY) {
    throw new Error("TERMII_API_KEY must be set");
  }

  const normalizedTo = to.startsWith("+234") ? to : normalizeNigerianPhone(to);

  const payload = JSON.stringify({
    to: normalizedTo,
    from: TERMII_SENDER_ID,
    sms: body,
    type: "plain",
    channel: "dnd",
    api_key: TERMII_API_KEY,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(`${TERMII_BASE_URL}/api/sms/send`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[Termii] SMS sent to ${normalizedTo}, message_id: ${parsed.message_id}`);
            resolve();
          } else {
            const err = new Error(`Termii error ${res.statusCode}: ${data}`);
            console.error(`[Termii] Failed to send SMS to ${normalizedTo}:`, err.message);
            reject(err);
          }
        } catch {
          reject(new Error(`Termii unparseable response: ${data}`));
        }
      });
    });

    req.on("error", (err) => {
      console.error(`[Termii] Request error for ${normalizedTo}:`, err.message);
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}
