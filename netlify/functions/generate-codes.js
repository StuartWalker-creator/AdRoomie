// Generates two short, memorable redemption codes for a joint campaign —
// e.g. "ANGIE15" — using the same free Gemini text model as the caption
// generator (text generation is reliable/free; that's why this is a text
// call, not another image experiment). If this fails for any reason, the
// client falls back to simple name-based codes automatically — proposing
// codes should never get stuck waiting on this.
//
// Same GEMINI_API_KEY env var as generate-caption.js — nothing new to set up
// if that's already configured.

const MODEL = "gemini-2.0-flash";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed." }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Not configured — missing GEMINI_API_KEY." }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request." }) };
  }

  const { businessA, businessB, offer } = payload || {};
  if (!businessA || !businessB) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing business names." }) };
  }

  const prompt = `Generate two short, memorable redemption codes for a joint small-business promo campaign.

Business A: ${businessA}
Business B: ${businessB}
Offer context: ${offer || "a joint discount promotion"}

Requirements for each code:
- 5-8 characters, uppercase letters and numbers only, no spaces, no symbols.
- Loosely inspired by that business's own name (not a generic word) so it's easy for a customer to remember and say out loud — e.g. a business called "Angie's Boutique" might get "ANGIE15".
- The two codes must be clearly different from each other.

Respond with ONLY raw JSON, nothing else, no markdown code fences, in exactly this shape:
{"codeA": "EXAMPLE1", "codeB": "EXAMPLE2"}`;

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
      return { statusCode: 502, body: JSON.stringify({ error: data?.error?.message || `Gemini API error (status ${res.status})` }) };
    }
    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim() || "";
    const cleaned = raw.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return { statusCode: 502, body: JSON.stringify({ error: "Model didn't return valid JSON — try again." }) };
    }
    const codeA = String(parsed.codeA || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const codeB = String(parsed.codeB || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!codeA || !codeB) {
      return { statusCode: 502, body: JSON.stringify({ error: "Model didn't return usable codes — try again." }) };
    }
    return { statusCode: 200, body: JSON.stringify({ codeA, codeB }) };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: "Couldn't reach the code generator — try again in a moment." }) };
  }
};
