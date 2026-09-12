# SpellCoco async relay (Cloudflare Worker)

One Durable Object per room, keyed by the room code. Stores the seats, the
latest game state, the config, and push subscriptions. Enforces turn order,
acks moves and new games with the sender's sequence number, applies Coco
attacks server-side, and sends Web Push turn alerts.

Deploy from this folder:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler deploy
```

Run locally (`npx wrangler dev --port 8787`) and point a client at
`ws://localhost:8787/r/CODE`.
