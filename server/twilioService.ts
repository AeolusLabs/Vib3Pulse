import twilio from "twilio";

function getClient(): twilio.Twilio {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }
  return twilio(accountSid, authToken);
}

export async function sendUKSMS(to: string, body: string): Promise<void> {
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;
  if (!fromNumber) {
    throw new Error("TWILIO_PHONE_NUMBER must be set");
  }
  const client = getClient();
  const message = await client.messages.create({ from: fromNumber, to, body });
  console.log(`[Twilio] SMS sent to ${to}, SID: ${message.sid}`);
}

// Validate that an inbound webhook came from Twilio
export function validateTwilioWebhook(
  signature: string,
  url: string,
  params: Record<string, string>
): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.error("[Twilio] AUTH_TOKEN not set — cannot validate webhook");
    return false;
  }
  return twilio.validateRequest(authToken, signature, url, params);
}

// Parse an inbound Twilio SMS webhook body into { from, body }
export function parseTwilioInboundSMS(params: Record<string, string>): {
  from: string;
  body: string;
} {
  return {
    from: params.From ?? "",
    body: (params.Body ?? "").trim(),
  };
}
