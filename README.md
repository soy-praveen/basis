# Basis

**The same BTC window, priced on two venues. Here is the gap, live.**

DreamDEX on Somnia and Polymarket on Polygon both run 5-minute and 15-minute BTC and ETH Up/Down windows on identical clock boundaries. Basis lines them up window by window, shows the live basis between the two order books, lets you take the cheaper side on DreamDEX in one click, and ships a bot that quotes DreamDEX around the Polymarket price so a dead DreamDEX window tracks the largest prediction market in the world.

Built for the Somnia x DreamDEX Event Contracts Hackathon. DreamDEX side runs on Somnia Shannon testnet. Polymarket side is public read-only data.

- Live app: _link in the submission_
- Repo layout: `web/` (Vite + React + viem terminal), `bot/quote.mjs` (quoting bot)

## What you see

Four cards, one per series: BTC 5m, ETH 5m, BTC 15m, ETH 15m. Each card shows the current window on both venues:

- **DreamDEX**: Up mid, best bid and ask with size, the window's reference price, read from `getBookLevels` on the window's pool every four seconds.
- **Polymarket**: Up mid, best bid and ask with size, three-level depth, read from the public CLOB `book` endpoint for the window's Up token every four seconds.
- **Basis**: DreamDEX Up mid minus Polymarket Up mid, in cents, with a two-line sparkline of both mids for the life of the window.
- **Edge**: when DreamDEX's ask is below Polymarket's bid (Up is cheaper on DreamDEX) or DreamDEX's bid is above Polymarket's ask (Down is cheaper on DreamDEX), the card says so and offers a one-click immediate-or-cancel `placeBinaryOrder` on the DreamDEX pool at the shown limit. Anything the book cannot fill is cancelled on chain.

Below the cards: a **scoreboard**. When a window rolls over, the last price each venue showed before the close is kept; once each venue settles on its own oracle, that price is scored against the outcome (Brier score and hit rate per venue), and windows where the two oracles settled on opposite sides are called out. Then a rolling log of every sample.

## Why the gap exists

Each venue fixes its own reference price at the window open and settles against its own oracle. DreamDEX uses its price-feed adapter on Somnia; Polymarket uses Chainlink on Polygon. Different reference, different oracle, different crowd. On 11 September 2026 the ETH 15-minute window closing at 06:45 UTC showed Up at 46.5 cents on Polymarket and about 20 cents on DreamDEX at the same moment. That is a real, hedgeable basis.

For DreamDEX it also answers a practical question: what should a market maker quote on a window nobody is trading yet? The Polymarket price for the same window is the best available fair value on earth, and it is free.

## The bot

`bot/quote.mjs` makes one DreamDEX series track Polymarket:

1. Find the DreamDEX window for the current slot from the module's `MarketCreated` logs.
2. Read the Polymarket Up mid for the same slot.
3. Mint one complete set of `SIZE` contracts on the pool so the ask side has inventory (`mintSet`), once per window.
4. Cancel its resting orders, then rest a post-only bid at `mid - SPREAD` and a post-only ask at `mid + SPREAD` (`placeBinaryOrder` with order type 3). A quote that would cross the DreamDEX book is skipped rather than taking liquidity.
5. Re-centre every `REQUOTE_MS`, pull quotes `STOP_BEFORE_SEC` before close, and log fills against a paper hedge at the Polymarket mid.

```bash
npm install
cp ../last-call/.env.example .env          # PRIVATE_KEY of a Shannon wallet with STT and tUSDC
SERIES=BTC/300 SPREAD=0.02 SIZE=20 npm run quote
```

The Polymarket hedge leg is deliberately left on paper. Trading on Polymarket needs a Polygon wallet with USDC and is geo-restricted; the point of the bot is to import Polymarket's price discovery into DreamDEX, not to run an arbitrage desk from a hackathon repo.

## Run the app

```bash
cd web && npm install && npm run dev       # http://127.0.0.1:5175
```

No backend. The browser reads the Shannon RPC and Polymarket's public API directly; Polymarket's endpoints send permissive CORS headers.

## Notes for the DreamDEX team

- Polymarket's 5-minute and 15-minute windows close on the same clock boundaries as DreamDEX's, so the same window can be compared without any mapping. That is a gift for liquidity: every DreamDEX window has a free external fair value.
- DreamDEX and Polymarket disagree by several cents most of the time on the same window. Some of that is the different reference price at open; some is that DreamDEX's book is thin. Publishing the reference price on the market contract (rather than only inside the question text or an oracle answer after the fact) would let tools like this explain the gap precisely.
- `getBookLevels` is fast enough to poll every few seconds from a browser through the public RPC. A websocket book feed for Event Contracts would make a terminal like this feel live rather than sampled.
- Post-only quoting from a script works well; the `PostOnlyWouldCross` revert is the right behaviour but is only documented in the SDK's gotchas page.
