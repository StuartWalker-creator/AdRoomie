// Keeps the OneSignal REST API key OFF the client entirely.
// Required env vars (Netlify dashboard → Site configuration → Environment variables):
//   ONESIGNAL_APP_ID, ONESIGNAL_REST_KEY

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let payload;
  try { payload = JSON.parse(event.body || "{}"); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) }; }

  const { playerId, title, message, url } = payload;
  if (!playerId || !message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "playerId and message are required" }) };
  }

  const appId = process.env.ONESIGNAL_APP_ID;
  const restKey = process.env.ONESIGNAL_REST_KEY;
  if (!appId || !restKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ONESIGNAL_APP_ID or ONESIGNAL_REST_KEY env vars" }) };
  }

  try {
    const response = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Key ${restKey}` },
      body: JSON.stringify({
        app_id: appId,
        include_player_ids: [playerId],
        headings: { en: title || "adRoomie" },
        contents: { en: message },
        url: url || undefined,
      }),
    });
    const data = await response.json();
    return { statusCode: response.ok ? 200 : response.status, headers, body: JSON.stringify(data) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Failed to reach OneSignal", detail: String(err) }) };
  }
};
