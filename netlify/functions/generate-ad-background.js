// Generates a decorative BACKGROUND ONLY for the combined ad image — no
// logos, no brand marks, nothing that needs to stay pixel-accurate. The
// client composites each business's real, untouched logo on top afterward.
// This split is deliberate: image-generation models are good at not
// mangling a reference logo, but "good" isn't "pixel-perfect," and a
// business's actual brand mark is exactly the thing that shouldn't be left
// to chance. Keeping logos out of the prompt entirely removes that risk
// completely, while still getting a genuinely AI-designed background.
//
// COST: $0. This uses Cloudflare Workers AI first — a real, recurring daily
// free allowance (not a one-time trial credit), no card required, ever. If
// that's not configured yet, or its daily free budget is used up, it falls
// back to Pollinations.ai — a free, no-signup, no-key image endpoint. If
// BOTH fail, the client falls back further to a plain gradient. A campaign
// is never blocked by any of this.
//
// ---------------- ONE-TIME SETUP (free, no card) ----------------
// 1. Sign up at https://dash.cloudflare.com/sign-up — email only, no card.
// 2. Find your Account ID: Cloudflare dashboard → Workers & Pages overview
//    (shown in the right sidebar), or Workers AI → Overview.
// 3. Create an API token: My Profile → API Tokens → Create Token →
//    use the "Workers AI" template (or a custom token with
//    Account > Workers AI > Read + Edit permissions).
// 4. In Netlify: Site settings → Environment variables, add:
//      CLOUDFLARE_ACCOUNT_ID = <your account id>
//      CLOUDFLARE_API_TOKEN  = <your token>
// 5. Redeploy.
//
// Skipping this setup isn't a dead end — the Pollinations.ai fallback below
// needs no configuration at all and will still generate real AI images,
// just with no uptime guarantee (it's a free community service, not a
// product with an SLA). Cloudflare is the more reliable free option.
// --------------------------------------------------------------

const CF_MODEL = "@cf/black-forest-labs/flux-1-schnell";

function buildPrompt(offer, mood) {
  return `Vibrant, modern square social-media ad background for a small-business joint promotion. Theme/mood: ${mood || "warm, inviting, purple-and-violet gradient tones, upbeat"}. Visual inspiration only, do not render any text: ${offer}. Purely decorative — abstract shapes, soft gradients, subtle texture. No people's faces, no readable text, no logos, no brand names anywhere. Keep the center-left and center-right areas calm and low-detail, reserved for logos to be placed on top afterward. Keep the lower third simple and uncluttered for a text card to sit on top later. Professional, attractive, high quality — not generic stock-photo clipart.`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request." }) };
  }

  const { offer, mood } = payload || {};
  if (!offer) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing offer details." }) };
  }

  const prompt = buildPrompt(offer, mood);

  // ---- Try 1: Cloudflare Workers AI — real free daily allowance ----
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (accountId && apiToken) {
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${CF_MODEL}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        }
      );
      const data = await res.json().catch(() => null);
      const image = data?.result?.image;
      if (res.ok && data?.success && image) {
        return { statusCode: 200, body: JSON.stringify({ imageBase64: image, mimeType: "image/jpeg", source: "cloudflare" }) };
      }
      // Not configured right, quota hit, or model hiccup — fall through to Pollinations below.
    } catch (e) {
      // Network issue reaching Cloudflare — fall through.
    }
  }

  // ---- Try 2: Pollinations.ai — free, no key, no signup, best-effort ----
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
    const res = await fetch(url);
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const base64 = Buffer.from(buf).toString("base64");
      const mimeType = res.headers.get("content-type") || "image/jpeg";
      return { statusCode: 200, body: JSON.stringify({ imageBase64: base64, mimeType, source: "pollinations" }) };
    }
  } catch (e) {
    // Both free sources failed — the client falls back to a plain gradient.
  }

  return {
    statusCode: 502,
    body: JSON.stringify({ error: "Couldn't reach a free image generator right now — try again in a moment, or use the simple gradient instead." }),
  };
};
