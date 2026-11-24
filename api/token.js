export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { grant_type, code, code_verifier, redirect_uri, refresh_token } = req.body || {};
  if (!["authorization_code", "refresh_token"].includes(grant_type)) {
    return res.status(400).json({ error: "unsupported_grant_type" });
  }

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    grant_type
  });
  if (code) body.set("code", code);
  if (code_verifier) body.set("code_verifier", code_verifier);
  if (redirect_uri) body.set("redirect_uri", redirect_uri);
  if (refresh_token) body.set("refresh_token", refresh_token);

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  res.status(r.status).json(await r.json());
}
