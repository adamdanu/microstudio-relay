# microstudio-relay

Vercel serverless relay for **MicroStudio**'s Gemini Key Pool.

## What it does

MicroStudio (a Next.js app on a self-hosted box) sends OpenAI-compatible
`/chat/completions` requests here. This function translates them to Gemini's
`generateContent` and forwards them **with the Gemini API key**, so Gemini sees
**Vercel's egress IPs** (shared, rotating) instead of the box's home IP.

The Gemini key pool round-robins across multiple keys in the app; this relay is
the thin, stateless hop that provides the rotating-IP egress. No keys are stored
here — they pass through in the request.

## Endpoint

`POST /api/relay`

Request (OpenAI-compatible, from MicroStudio's `chatCompletions`):
```json
{
  "model": "gemini-2.5-flash",
  "messages": [
    { "role": "user", "content": [
      { "type": "text", "text": "Describe this image." },
      { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
    ]}
  ],
  "temperature": 0.2,
  "max_tokens": 4096
}
```

Headers:
- `Authorization: Bearer <Gemini-API-Key>` — the key from the pool
- `x-relay-token: <RELAY_AUTH_TOKEN>` — required shared secret (else 401)

Response (OpenAI-shaped, so MicroStudio's existing parsing + analytics work):
```json
{
  "choices": [{ "index": 0, "finish_reason": "stop", "message": { "role": "assistant", "content": "..." } }],
  "usage": { "prompt_tokens": 123, "completion_tokens": 45 }
}
```

## Security

- Requires `x-relay-token` header matching the `RELAY_AUTH_TOKEN` env var. No open proxy.
- Model is validated against an allowlist.
- Gemini keys only transit the request; never stored.

## Deploy

```bash
npm i -g vercel
vercel login
vercel link --yes            # create/link project microstudio-relay
vercel env add RELAY_AUTH_TOKEN production   # paste your random token
vercel deploy --prod
```

Then in MicroStudio → Admin → Key Pools, set the pool's **Relay URL** to your
production URL (no trailing slash).