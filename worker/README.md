# SpellCoco async relay (Cloudflare Worker)

One Durable Object per room, keyed by the room code. Stores the seats, the
latest game state, the config, and push subscriptions. Enforces turn order,
acks moves and new games with the sender's sequence number, applies Coco
attacks server-side, and sends Web Push turn alerts.

Deploy from this folder:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler deploy
```

Clients adapt to what the deployed relay supports: the welcome message lists
`caps` (v73: `livesel`, live selection previews that are relayed but never
stored). Until a relay with `livesel` is deployed, clients keep sending a full
game state per selected letter, as before — so deploying is safe at any time
and only reduces storage writes.

Run locally (`npx wrangler dev --port 8787`) and point a client at
`ws://localhost:8787/r/CODE`.
