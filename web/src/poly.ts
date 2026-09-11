// Polymarket public data: the 5-minute and 15-minute BTC/ETH Up/Down windows.
// Slugs are `${asset}-updown-${interval}m-${windowStartUnix}` and the windows sit on
// the same clock boundaries DreamDEX uses, so the same window can be compared.

export type PolyWindow = {
  slug: string;
  title: string;
  upToken: string;
  downToken: string;
  start: number;
  end: number;
  outcomePrices: [number, number];
};

export type Book = { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] };

const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

export const polySlug = (asset: "btc" | "eth", intervalSec: number, start: number) => `${asset}-updown-${intervalSec / 60}m-${start}`;
export const polyUrl = (slug: string) => `https://polymarket.com/event/${slug}`;

const cache = new Map<string, PolyWindow | null>();

export async function fetchPolyWindow(asset: "btc" | "eth", intervalSec: number, start: number): Promise<PolyWindow | null> {
  const slug = polySlug(asset, intervalSec, start);
  if (cache.has(slug)) return cache.get(slug)!;
  try {
    const r = await fetch(`${GAMMA}/events?slug=${slug}`);
    const d = await r.json();
    const e = d?.[0];
    const m = e?.markets?.[0];
    if (!m) {
      cache.set(slug, null);
      return null;
    }
    const tokens: string[] = JSON.parse(m.clobTokenIds || "[]");
    const prices: string[] = JSON.parse(m.outcomePrices || "[]");
    const w: PolyWindow = {
      slug,
      title: e.title,
      upToken: tokens[0],
      downToken: tokens[1],
      start,
      end: start + intervalSec,
      outcomePrices: [Number(prices[0] || 0.5), Number(prices[1] || 0.5)],
    };
    cache.set(slug, w);
    return w;
  } catch {
    return null;
  }
}

export async function fetchBook(tokenId: string): Promise<Book | null> {
  try {
    const r = await fetch(`${CLOB}/book?token_id=${tokenId}`);
    const d = await r.json();
    const norm = (x: any[]) => (x || []).map((l) => ({ price: Number(l.price), size: Number(l.size) })).sort((a, b) => a.price - b.price);
    const bids = norm(d.bids).reverse(); // best bid first
    const asks = norm(d.asks); // best ask first
    return { bids, asks };
  } catch {
    return null;
  }
}

export const bookMid = (b: Book | null): number | null => {
  if (!b) return null;
  const bid = b.bids[0]?.price, ask = b.asks[0]?.price;
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  return bid ?? ask ?? null;
};
export const depth = (b: Book | null, levels = 3) => {
  if (!b) return { bid: 0, ask: 0 };
  return { bid: b.bids.slice(0, levels).reduce((a, l) => a + l.size, 0), ask: b.asks.slice(0, levels).reduce((a, l) => a + l.size, 0) };
};

/** Settled outcome of a Polymarket window: 1 if Up won, 0 if Down, null while open. */
export async function fetchPolyOutcome(slug: string): Promise<number | null> {
  try {
    const r = await fetch(`${GAMMA}/events?slug=${slug}`);
    const d = await r.json();
    const m = d?.[0]?.markets?.[0];
    if (!m) return null;
    const prices: string[] = JSON.parse(m.outcomePrices || "[]");
    const up = Number(prices[0]), down = Number(prices[1]);
    const closed = Boolean(m.closed) || m.umaResolutionStatus === "resolved";
    if (!closed && !(up === 1 || down === 1)) return null;
    if (up >= 0.99 && down <= 0.01) return 1;
    if (down >= 0.99 && up <= 0.01) return 0;
    return null;
  } catch {
    return null;
  }
}
