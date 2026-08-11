// Shared relay handler for MicroStudio's Gemini Key Pool.
// The Next.js app sends OpenAI-compatible chat completions to either
// /api/relay or /chat/completions; both forward to Gemini so Gemini sees
// Vercel's egress IPs (rotating, shared) instead of the self-hosted box's IP.
//
// Security:
//  - REQUIRES x-relay-token header == RELAY_AUTH_TOKEN env (else 401). No open proxy.
//  - Model is validated against an allowlist.
//  - Gemini keys pass through in the Authorization header; never stored here.
import type { VercelRequest, VercelResponse } from "@vercel/node"

const ALLOWED_MODELS = [
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
]

// Convert an OpenAI-format message array into Gemini "contents".
function toGeminiContents(messages: any[]): any[] {
  return messages.map((m: any) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: (m.content || []).map((part: any) => {
      if (part.type === "image_url") {
        const url: string = part.image_url?.url || ""
        const b64 = url.split(",")[1] || url
        return { inline_data: { mime_type: "image/png", data: b64 } }
      }
      return { text: typeof part === "string" ? part : (part.text || "") }
    }),
  }))
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Gate: only the app with the relay token may call.
  const token = req.headers["x-relay-token"]
  const expected = process.env.RELAY_AUTH_TOKEN
  if (!expected || token !== expected) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  const { model, messages, temperature, max_tokens } = req.body || {}
  const apiKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "")

  if (!apiKey) return res.status(400).json({ error: "Missing Gemini API key" })
  if (!model) return res.status(400).json({ error: "Missing model" })
  if (!ALLOWED_MODELS.includes(model)) return res.status(400).json({ error: "Model not allowed" })

  const base = process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com/v1beta"
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: toGeminiContents(messages || []),
        generationConfig: { temperature: temperature ?? 0.2, maxOutputTokens: max_tokens ?? 4096 },
      }),
    })

    const text = await upstream.text()
    // Pass through status + body so the app can react to 429/5xx for key failover.
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: "upstream", detail: text.slice(0, 1000) })
    }

    let gemini: any
    try {
      gemini = JSON.parse(text)
    } catch {
      return res.status(502).json({ error: "invalid upstream response", detail: text.slice(0, 500) })
    }

    // Translate Gemini -> OpenAI shape (content + usage) for the app.
    const parts: string[] = []
    const candidates = gemini?.candidates || []
    for (const c of candidates) {
      for (const p of c?.content?.parts || []) {
        if (p.text) parts.push(p.text)
      }
    }
    const content = parts.join("\n")
    const usage = gemini?.usageMetadata || {}
    return res.status(200).json({
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: {
        prompt_tokens: usage?.promptTokenCount ?? 0,
        completion_tokens: usage?.candidatesTokenCount ?? 0,
      },
    })
  } catch (e: any) {
    return res.status(502).json({ error: e?.message || "relay error" })
  }
}