// Generates a ready-to-post joint-campaign caption for two partnered
// businesses. Uses Google's Gemini API (free tier as of when this was
// written) so it costs nothing at adRoomie's current scale.
//
// ---------------- ONE-TIME SETUP ----------------
// 1. Get a free API key: https://aistudio.google.com/apikey  (no card needed)
// 2. In Netlify: Site settings → Environment variables → add
//      GEMINI_API_KEY = <your key>
// 3. Redeploy the site. That's it.
//
// Google renames/retires free-tier model IDs sometimes — if this starts
// failing, check the current free-tier model list at
// https://ai.google.dev/gemini-api/docs/pricing and update MODEL below.
// --------------------------------------------------

const MODEL = "gemini-3.6-flash";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Caption generator isn't set up yet — missing GEMINI_API_KEY in Netlify's environment variables." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request." }) };
  }

  const { businessA, businessB, offer, codeA, codeB } = payload || {};
  if (!businessA?.name || !businessB?.name || !offer) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing business names or offer details." }) };
  }

  const codesLine = (codeA && codeB)
    ? `Redemption codes (use these EXACT codes, do not invent different ones): customers show "${codeA}" at ${businessB.name} to redeem; customers show "${codeB}" at ${businessA.name} to redeem.`
    : `No redemption codes exist yet for this campaign — do NOT invent or make up a code. Instead, the "How to claim" steps should just say to ask in-store or DM either business to claim.`;

  const prompt = `Write a short, upbeat Instagram/Facebook caption for a JOINT ad campaign between two small local businesses co-promoting each other.

Business A: ${businessA.name}${businessA.location ? ` (${businessA.location})` : ""}${businessA.website ? `, ${businessA.website}` : ""}
Business B: ${businessB.name}${businessB.location ? ` (${businessB.location})` : ""}${businessB.website ? `, ${businessB.website}` : ""}
The offer: ${offer}
${codesLine}

Requirements:
- Open with 1-2 emojis that genuinely fit both businesses, not generic ones.
- Mention both business names naturally in the copy.
- Clearly state the offer/deal.
- Include a short numbered "How to claim" section (2-3 steps max) — follow the redemption codes instruction above exactly, never invent a code that wasn't given to you.
- End with 3-5 relevant local hashtags (assume Uganda/East Africa unless a location given suggests otherwise).
- Keep it under 120 words total.
- Plain text only — no markdown formatting, no asterisks — ready to paste straight into Instagram.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      }
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = data?.error?.message || `Gemini API error (status ${res.status})`;
      return { statusCode: 502, body: JSON.stringify({ error: msg }) };
    }
    const caption = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
    if (!caption) {
      return { statusCode: 502, body: JSON.stringify({ error: "No caption came back from the model — try again." }) };
    }
    return { statusCode: 200, body: JSON.stringify({ caption }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Couldn't reach the caption generator — try again in a moment." }) };
  }
};
