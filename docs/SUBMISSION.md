# DoraHacks submission text: Basis

## Project name

Basis

## One-liner (vision)

Live cross-venue basis between DreamDEX Event Contracts and Polymarket for the same BTC/ETH window on the same clock, one-click takes of the cheaper side on DreamDEX, and a bot that makes a DreamDEX window track Polymarket's price.

## Description

Polymarket's 5-minute and 15-minute BTC/ETH Up/Down markets close on exactly the same clock boundaries as DreamDEX's Event Contract windows. That means every DreamDEX window has a free, deep external fair value nobody was using. Basis puts the two side by side.

- **Terminal**: four cards (BTC 5m, ETH 5m, BTC 15m, ETH 15m). Each shows DreamDEX's on-chain Up book (mid, best bid/ask, size, reference price) next to Polymarket's public CLOB for the same window, the basis in cents, and a sparkline of both mids over the window. Sampled every four seconds directly from the Shannon RPC and Polymarket's API, no backend.
- **Edge and take**: when DreamDEX's ask sits below Polymarket's bid, or its bid above Polymarket's ask, the card names the cheaper side and offers a one-click immediate-or-cancel `placeBinaryOrder` on the DreamDEX pool at zero fees.
- **Quoting bot**: `bot/quote.mjs` mints a set for inventory, then rests post-only bids and asks on DreamDEX around the Polymarket mid, re-centres every 20 seconds, pulls quotes before close, and logs fills against a paper hedge. It is the shortest path from "dead DreamDEX window" to "priced like the biggest market in the world".

Observed on 11 September 2026: on the ETH 15-minute window closing at 06:45 UTC, Polymarket had Up at 46.5 cents while DreamDEX's book sat around 20 cents. Gaps of 4 to 10 cents were common across the day.

Why it matters for DreamDEX: it imports external price discovery into thin windows, gives market makers a reference to quote against, and gives traders a reason to prefer DreamDEX (same window, zero fees, on-chain settlement in seconds).

## SDK and docs feedback

- Windows on the two venues align perfectly by close time, which is worth documenting as a liquidity strategy.
- The reference price is not exposed on the market contract for the 15-minute and 1-hour series at creation; it only appears in the question text and the oracle answer. Exposing it would let tools explain cross-venue gaps.
- A websocket feed for Event Contract books would remove the need to poll `getBookLevels`.
- `PostOnlyWouldCross` is the right behaviour for a quoting bot, but a simulation helper in the SDK that says "this post-only would cross" before sending would save gas.

## Links

- GitHub: https://github.com/soy-praveen/basis
- Live app: https://soy-praveen.github.io/basis/
- Demo video: _YouTube link_
