// Registers this app's webhook endpoint with Zernio (run once per environment).
//
//   APP_URL=https://vib3pulse.app ZERNIO_WEBHOOK_SECRET=<long random string> \
//     node --env-file=.env scripts/register-zernio-webhook.mjs
//
// Needs ZERNIO_API_KEY / ZERNIO_BASE_URL (already in .env) and a ZERNIO_WEBHOOK_SECRET you make up
// (e.g. `openssl rand -hex 32`). Set the SAME secret as ZERNIO_WEBHOOK_SECRET on the server, or every
// delivery is rejected. Prints what it sent; it does not run automatically anywhere.
const { ZERNIO_API_KEY, ZERNIO_BASE_URL, ZERNIO_WEBHOOK_SECRET, APP_URL } = process.env;
if (!ZERNIO_API_KEY || !ZERNIO_BASE_URL || !ZERNIO_WEBHOOK_SECRET || !APP_URL) {
  console.error("Set ZERNIO_API_KEY, ZERNIO_BASE_URL, ZERNIO_WEBHOOK_SECRET and APP_URL first.");
  process.exit(2);
}

const body = {
  name: "vib3pulse-social",
  url: `${APP_URL.replace(/\/$/, "")}/api/webhooks/zernio`,
  secret: ZERNIO_WEBHOOK_SECRET,
  events: ["post.published", "post.failed", "account.disconnected"],
  isActive: true,
};

const res = await fetch(`${ZERNIO_BASE_URL.replace(/\/$/, "")}/v1/webhooks/settings`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${ZERNIO_API_KEY}` },
  body: JSON.stringify(body),
});
console.log(`${res.status} ${res.statusText}`);
console.log(await res.text());
console.log(`\nRegistered ${body.url} for: ${body.events.join(", ")}`);
console.log("Next: set ZERNIO_WEBHOOK_SECRET on the server, then send a test delivery from Zernio (POST /v1/webhooks/test).");
process.exit(res.ok ? 0 : 1);
