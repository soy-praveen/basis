import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchDreamWindows, fetchDreamBook, dreamMid, takeOnDream, connectWallet, silentWallet, txUrl, addrUrl, type DreamWindow, type DreamBook, type Wallet } from "./dream";
import { fetchPolyWindow, fetchBook, bookMid, depth, polyUrl, fetchPolyOutcome, type PolyWindow, type Book } from "./poly";
import { pub, marketAbi } from "./dream";

type Series = { asset: "BTC" | "ETH"; intervalSec: number };
const SERIES: Series[] = [
  { asset: "BTC", intervalSec: 300 },
  { asset: "ETH", intervalSec: 300 },
  { asset: "BTC", intervalSec: 900 },
  { asset: "ETH", intervalSec: 900 },
];
const key = (s: Series) => `${s.asset}/${s.intervalSec}`;
const windowStart = (intervalSec: number, t = Math.floor(Date.now() / 1000)) => Math.floor(t / intervalSec) * intervalSec;
const mmss = (s: number) => `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, "0")}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;
const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
const cents = (p: number | null) => (p === null ? "—" : (p * 100).toFixed(1) + "¢");

type Sample = { t: number; dream: number | null; poly: number | null };
type Row = {
  series: Series;
  start: number;
  end: number;
  dream: DreamWindow | null;
  dreamBook: DreamBook | null;
  poly: PolyWindow | null;
  polyBook: Book | null;
  samples: Sample[];
};

type Scored = {
  key: string;
  series: string;
  start: number;
  end: number;
  dreamLast: number | null;
  polyLast: number | null;
  dreamMarket: string | null;
  polySlug: string | null;
  dreamOutcome: number | null; // 1 up, 0 down
  polyOutcome: number | null;
};
const HKEY = "basis.history.v1";
const loadHistory = (): Scored[] => {
  try {
    return JSON.parse(localStorage.getItem(HKEY) || "[]");
  } catch {
    return [];
  }
};
const saveHistory = (h: Scored[]) => {
  try {
    localStorage.setItem(HKEY, JSON.stringify(h.slice(-200)));
  } catch {}
};

export default function App() {
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [toast, setToast] = useState<{ msg: string; err: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [size, setSize] = useState("5");
  const dreamAll = useRef<DreamWindow[]>([]);
  const [history, setHistory] = useState<Scored[]>(() => loadHistory());
  const log = useRef<{ t: number; series: string; dream: number | null; poly: number | null }[]>([]);

  const say = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    setTimeout(() => setToast(null), err ? 8000 : 4000);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    silentWallet().then((w) => w && setWallet(w));
    return () => clearInterval(t);
  }, []);

  // discover DreamDEX windows every 20s
  useEffect(() => {
    const go = () => fetchDreamWindows(4).then((w) => (dreamAll.current = w)).catch(() => {});
    go();
    const t = setInterval(go, 20000);
    return () => clearInterval(t);
  }, []);

  // refresh books every 4s
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      const t = Math.floor(Date.now() / 1000);
      const next: Record<string, Row> = {};
      await Promise.all(
        SERIES.map(async (s) => {
          const start = windowStart(s.intervalSec, t);
          const end = start + s.intervalSec;
          const k = key(s);
          const prev = rowsRef.current[k];
          const dream = dreamAll.current.find((w) => w.asset === s.asset && w.intervalSec === s.intervalSec && w.expiry === end) || null;
          const [dreamBook, poly] = await Promise.all([dream ? fetchDreamBook(dream.pool).catch(() => null) : Promise.resolve(null), fetchPolyWindow(s.asset.toLowerCase() as "btc" | "eth", s.intervalSec, start)]);
          const polyBook = poly ? await fetchBook(poly.upToken) : null;
          const sample: Sample = { t, dream: dreamMid(dreamBook), poly: bookMid(polyBook) };
          const samples = prev && prev.start === start ? [...prev.samples, sample].slice(-120) : [sample];
          if (prev && prev.start !== start) {
            // window rolled over: keep the last quotes seen before the close for scoring
            const lastD = [...prev.samples].reverse().find((x) => x.dream !== null)?.dream ?? null;
            const lastP = [...prev.samples].reverse().find((x) => x.poly !== null)?.poly ?? null;
            if (lastD !== null || lastP !== null) {
              const entry: Scored = { key: `${k}-${prev.start}`, series: `${s.asset} ${s.intervalSec / 60}m`, start: prev.start, end: prev.end, dreamLast: lastD, polyLast: lastP, dreamMarket: prev.dream?.market || null, polySlug: prev.poly?.slug || null, dreamOutcome: null, polyOutcome: null };
              setHistory((h) => (h.some((x) => x.key === entry.key) ? h : [...h, entry]));
            }
          }
          if (sample.dream !== null || sample.poly !== null) log.current.push({ t, series: `${s.asset} ${s.intervalSec / 60}m`, dream: sample.dream, poly: sample.poly });
          next[k] = { series: s, start, end, dream, dreamBook, poly, polyBook, samples };
        })
      );
      if (!stop) setRows(next);
    };
    const rowsRef = { current: {} as Record<string, Row> };
    const wrapped = async () => {
      rowsRef.current = latest.current;
      await tick();
    };
    wrapped();
    const t = setInterval(wrapped, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const latest = useRef<Record<string, Row>>({});
  latest.current = rows;

  // score archived windows once each venue has settled on its own oracle
  const pendingCount = history.filter((h) => (h.dreamOutcome === null && h.dreamMarket) || (h.polyOutcome === null && h.polySlug)).length;
  useEffect(() => {
    saveHistory(history);
  }, [history]);
  useEffect(() => {
    if (!pendingCount) return;
    let cancelled = false;
    const run = async () => {
      const pending = loadHistory().filter((h) => (h.dreamOutcome === null && h.dreamMarket) || (h.polyOutcome === null && h.polySlug)).slice(0, 12);
      const updates = new Map<string, Partial<Scored>>();
      await Promise.all(
        pending.map(async (h) => {
          const u: Partial<Scored> = {};
          if (h.dreamOutcome === null && h.dreamMarket) {
            try {
              const [resolved, pn] = await Promise.all([
                pub.readContract({ address: h.dreamMarket as `0x${string}`, abi: marketAbi, functionName: "isResolved" }),
                pub.readContract({ address: h.dreamMarket as `0x${string}`, abi: marketAbi, functionName: "payoutNumerators" }),
              ]);
              if (resolved && pn.length >= 2) u.dreamOutcome = pn[0] > pn[1] ? 1 : 0;
            } catch {}
          }
          if (h.polyOutcome === null && h.polySlug) {
            const o = await fetchPolyOutcome(h.polySlug);
            if (o !== null) u.polyOutcome = o;
          }
          if (Object.keys(u).length) updates.set(h.key, u);
        })
      );
      if (!cancelled && updates.size) setHistory((hs) => hs.map((h) => (updates.has(h.key) ? { ...h, ...updates.get(h.key) } : h)));
    };
    run();
    const t = setInterval(run, 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [pendingCount]);

  const connect = async () => {
    try {
      setWallet(await connectWallet());
    } catch (e: any) {
      say(e?.shortMessage || e?.message || String(e), true);
    }
  };

  const take = async (r: Row, side: 0 | 1, limit: number) => {
    if (!wallet) return connect();
    if (!r.dream || !r.dreamBook) return;
    setBusy(key(r.series));
    try {
      const hash = await takeOnDream(wallet, r.dream, side, Number(size) || 1, limit, r.dreamBook);
      say(`Filled on DreamDEX · ${hash.slice(0, 10)}…`);
      window.open(txUrl(hash), "_blank");
    } catch (e: any) {
      say((e?.shortMessage || e?.message || String(e)).split("\n")[0].slice(0, 200), true);
    } finally {
      setBusy(null);
    }
  };

  const summary = useMemo(() => {
    const live = Object.values(rows).filter((r) => r.dreamBook && r.polyBook);
    const spreads = live.map((r) => (dreamMid(r.dreamBook)! - bookMid(r.polyBook)!) * 100);
    return { live: live.length, avgAbs: spreads.length ? spreads.reduce((a, b) => a + Math.abs(b), 0) / spreads.length : 0, samples: log.current.length };
  }, [rows]);

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <span className="name">
            Bas<i>is</i>
          </span>
          <span className="sub">DreamDEX × Polymarket · same window, same clock</span>
        </div>
        <div className="right">
          <span className="chip">
            live pairs <b>{summary.live}</b> · avg |basis| <b>{summary.avgAbs.toFixed(1)}¢</b> · samples <b>{summary.samples}</b>
          </span>
          {wallet ? (
            <span className="chip">
              <b>
                {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
              </b>
            </span>
          ) : (
            <button className="btn primary" onClick={connect}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      <section className="hero">
        <h1>The same BTC window is priced on two venues. Here is the gap, live.</h1>
        <p>
          DreamDEX on Somnia and Polymarket on Polygon both run 5-minute and 15-minute Up/Down windows on identical clock boundaries. Basis reads DreamDEX's on-chain order book
          and Polymarket's public CLOB every four seconds, lines them up window by window, and lets you take the cheaper side on DreamDEX with one click at zero fees.
        </p>
      </section>

      <div className="legend">
        <span>
          <span className="sw dream" />
          DreamDEX Up mid (Somnia Shannon, on-chain book)
        </span>
        <span>
          <span className="sw poly" />
          Polymarket Up mid (Polygon CLOB, public API)
        </span>
        <span style={{ marginLeft: "auto" }}>
          size for one-click takes:{" "}
          <input value={size} onChange={(e) => setSize(e.target.value)} style={{ width: 56, fontFamily: "var(--mono)", padding: "3px 6px", border: "1px solid var(--line2)", borderRadius: 6 }} /> contracts
        </span>
      </div>

      <div className="grid">
        {SERIES.map((s) => {
          const r = rows[key(s)];
          return <Card key={key(s)} r={r} s={s} now={now} busy={busy === key(s)} take={take} wallet={wallet} />;
        })}
      </div>

      <div className="notes">
        <div className="note">
          <b>Why the gap exists</b>
          Each venue fixes its own reference price at the window open and settles against its own oracle. Different reference, different oracle, different crowd. A 10¢ gap on the same
          window is a real, hedgeable basis, not a display error.
        </div>
        <div className="note">
          <b>What "take" does</b>
          It sends an immediate-or-cancel <code>placeBinaryOrder</code> to the DreamDEX pool at the shown limit. Anything the book cannot fill is cancelled on chain. DreamDEX charges no maker or
          taker fee on Event Contracts.
        </div>
        <div className="note">
          <b>The bot in the repo</b>
          <code>bot/quote.mjs</code> quotes DreamDEX two-sided around the Polymarket mid, post-only, and re-centres every 20 seconds. It is the simplest way to make a dead DreamDEX window track the
          largest prediction market in the world.
        </div>
      </div>

      <Scoreboard history={history} />

      <BasisLog log={log.current} now={now} />

      <div className="foot">
        Polymarket data: gamma-api.polymarket.com and clob.polymarket.com, read-only. DreamDEX data: <code>getBookLevels</code> on each window's pool via the Shannon RPC. Windows are matched by
        asset, interval and close time. Nothing here trades on Polymarket; the hedge leg is left to the reader's own Polygon wallet.
      </div>
      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

function Card({ r, s, now, busy, take, wallet }: { r: Row | undefined; s: Series; now: number; busy: boolean; take: (r: Row, side: 0 | 1, limit: number) => Promise<void>; wallet: Wallet | null }) {
  const start = windowStart(s.intervalSec, now), end = start + s.intervalSec;
  const dm = r ? dreamMid(r.dreamBook) : null;
  const pm = r ? bookMid(r.polyBook) : null;
  const basis = dm !== null && pm !== null ? dm - pm : null;
  const dBid = r?.dreamBook?.bids[0], dAsk = r?.dreamBook?.asks[0];
  const pBid = r?.polyBook?.bids[0], pAsk = r?.polyBook?.asks[0];
  const pd = depth(r?.polyBook || null);
  // edge: Up is cheaper on DreamDEX if DreamDEX ask < Polymarket bid (you could buy Up here and sell there)
  let edge: { side: 0 | 1; text: string; limit: number; cls: string } | null = null;
  if (dAsk && pBid && dAsk.price < pBid.price) edge = { side: 0, text: `UP is ${((pBid.price - dAsk.price) * 100).toFixed(1)}¢ cheaper on DreamDEX (ask ${cents(dAsk.price)} vs Polymarket bid ${cents(pBid.price)})`, limit: Math.min(0.99, dAsk.price + 0.01), cls: "up" };
  else if (dBid && pAsk && dBid.price > pAsk.price) edge = { side: 1, text: `DOWN is ${((dBid.price - pAsk.price) * 100).toFixed(1)}¢ cheaper on DreamDEX (Up bid ${cents(dBid.price)} vs Polymarket ask ${cents(pAsk.price)})`, limit: Math.max(0.01, dBid.price - 0.01), cls: "down" };
  return (
    <div className="card">
      <div className="head">
        <div className="title">
          {s.asset} {s.intervalSec / 60}m
          <small>
            {hhmm(start)} → {hhmm(end)} UTC
          </small>
        </div>
        <div className="clock">
          closes in <b>{mmss(end - now)}</b>
        </div>
      </div>
      <div className="venues">
        <div className="venue dream">
          <div className="vn">
            <span>DreamDEX</span>
            {r?.dream && (
              <a href={addrUrl(r.dream.pool)} target="_blank" rel="noreferrer">
                pool ↗
              </a>
            )}
          </div>
          <div className="mid pop" key={`d${dm ?? "x"}`}>
            {cents(dm)}
            <small>Up mid</small>
          </div>
          <div className="bo">
            <span>
              bid <b>{cents(dBid?.price ?? null)}</b> × {dBid ? dBid.quantity.toFixed(0) : "—"}
            </span>
            <span>
              ask <b>{cents(dAsk?.price ?? null)}</b> × {dAsk ? dAsk.quantity.toFixed(0) : "—"}
            </span>
          </div>
          <div className="strike">{r?.dream ? (r.dream.strike > 0 ? `reference ${r.dream.strike.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : "reference set at open by DreamDEX oracle") : "window not found on chain yet"}</div>
        </div>
        <div className="venue poly">
          <div className="vn">
            <span>Polymarket</span>
            {r?.poly && (
              <a href={polyUrl(r.poly.slug)} target="_blank" rel="noreferrer">
                market ↗
              </a>
            )}
          </div>
          <div className="mid pop" key={`p${pm ?? "x"}`}>
            {cents(pm)}
            <small>Up mid</small>
          </div>
          <div className="bo">
            <span>
              bid <b>{cents(pBid?.price ?? null)}</b> × {pBid ? pBid.size.toFixed(0) : "—"}
            </span>
            <span>
              ask <b>{cents(pAsk?.price ?? null)}</b> × {pAsk ? pAsk.size.toFixed(0) : "—"}
            </span>
          </div>
          <div className="strike">{r?.poly ? `depth 3 levels: ${pd.bid.toFixed(0)} bid / ${pd.ask.toFixed(0)} ask · Chainlink settled` : "no Polymarket window for this slot"}</div>
        </div>
      </div>
      <div className="basis">
        <div>
          <div className="bl">
            basis · <b>DreamDEX − Polymarket</b> on the Up side
          </div>
          <div key={`b${basis ?? "x"}`} className={`b pop ${basis === null ? "" : basis >= 0 ? "pos" : "neg"}`}>{basis === null ? "—" : `${basis >= 0 ? "+" : ""}${(basis * 100).toFixed(1)}¢`}</div>
        </div>
        <div className="bl" style={{ textAlign: "right" }}>
          {basis === null ? "waiting for both books" : Math.abs(basis) < 0.02 ? "venues agree" : basis > 0 ? "DreamDEX is more bullish" : "DreamDEX is more bearish"}
          <br />
          {r?.samples.length || 0} samples this window
        </div>
      </div>
      {edge ? (
        <div className={`edge ${edge.cls}`}>
          <span>{edge.text}</span>
          <button className="btn sm primary" disabled={busy || !r?.dream} onClick={() => r && take(r, edge!.side, edge!.limit)}>
            {busy ? "Sending…" : wallet ? `Take ${edge.side === 0 ? "UP" : "DOWN"} on DreamDEX` : "Connect to take"}
          </button>
        </div>
      ) : (
        <div className="edge">
          <span style={{ color: "var(--muted)" }}>No crossable edge right now: DreamDEX's book sits inside Polymarket's.</span>
          {r?.dream && dAsk && (
            <button className="btn sm" disabled={busy} onClick={() => r && take(r, 0, Math.min(0.99, dAsk.price + 0.01))}>
              {wallet ? "Buy UP at ask anyway" : "Connect"}
            </button>
          )}
        </div>
      )}
      <Spark samples={r?.samples || []} />
    </div>
  );
}

function Spark({ samples }: { samples: Sample[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, W, H);
    const pts = samples.filter((s) => s.dream !== null || s.poly !== null);
    if (pts.length < 2) {
      g.fillStyle = "#94a3b8";
      g.font = "11px DM Mono, monospace";
      g.fillText("collecting samples…", 4, 14);
      return;
    }
    const vals = pts.flatMap((s) => [s.dream, s.poly]).filter((v): v is number => v !== null);
    const lo = Math.max(0, Math.min(...vals) - 0.03), hi = Math.min(1, Math.max(...vals) + 0.03);
    const x = (i: number) => (i / (pts.length - 1)) * (W - 2) + 1;
    const y = (v: number) => H - 2 - ((v - lo) / (hi - lo || 1)) * (H - 4);
    const line = (k: "dream" | "poly", color: string) => {
      g.beginPath();
      g.strokeStyle = color;
      g.lineWidth = 1.6;
      let started = false;
      pts.forEach((s, i) => {
        const v = s[k];
        if (v === null) return;
        if (!started) {
          g.moveTo(x(i), y(v));
          started = true;
        } else g.lineTo(x(i), y(v));
      });
      g.stroke();
    };
    line("poly", "#2563eb");
    line("dream", "#7c3aed");
    g.fillStyle = "#94a3b8";
    g.font = "10px DM Mono, monospace";
    g.fillText(`${(hi * 100).toFixed(0)}¢`, 2, 10);
    g.fillText(`${(lo * 100).toFixed(0)}¢`, 2, H - 3);
  }, [samples]);
  return <canvas ref={ref} className="spark" />;
}

function BasisLog({ log, now }: { log: { t: number; series: string; dream: number | null; poly: number | null }[]; now: number }) {
  const last = log.slice(-12).reverse();
  return (
    <div className="panel">
      <h3>Last samples</h3>
      <table className="tbl">
        <thead>
          <tr>
            <th>time</th>
            <th>window</th>
            <th className="r">DreamDEX up</th>
            <th className="r">Polymarket up</th>
            <th className="r">basis</th>
          </tr>
        </thead>
        <tbody>
          {last.map((l, i) => (
            <tr key={i}>
              <td>{new Date(l.t * 1000).toISOString().slice(11, 19)}</td>
              <td>{l.series}</td>
              <td className="r">{cents(l.dream)}</td>
              <td className="r">{cents(l.poly)}</td>
              <td className="r">{l.dream !== null && l.poly !== null ? `${((l.dream - l.poly) * 100).toFixed(1)}¢` : "—"}</td>
            </tr>
          ))}
          {last.length === 0 && (
            <tr>
              <td colSpan={5} style={{ color: "var(--muted)" }}>
                Sampling… ({now % 2 === 0 ? "·" : "··"})
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


function Scoreboard({ history }: { history: Scored[] }) {
  const scored = history.filter((h) => h.dreamOutcome !== null || h.polyOutcome !== null);
  const brier = (p: number | null, o: number | null) => (p === null || o === null ? null : (p - o) ** 2);
  const stat = (venue: "dream" | "poly") => {
    const rows = scored
      .map((h) => ({ p: venue === "dream" ? h.dreamLast : h.polyLast, o: venue === "dream" ? h.dreamOutcome : h.polyOutcome }))
      .filter((x) => x.p !== null && x.o !== null) as { p: number; o: number }[];
    const n = rows.length;
    const hit = rows.filter((x) => (x.p >= 0.5 ? 1 : 0) === x.o).length;
    const b = n ? rows.reduce((a, x) => a + (x.p - x.o) ** 2, 0) / n : null;
    return { n, hit, b };
  };
  const d = stat("dream"), p = stat("poly");
  const disagree = scored.filter((h) => h.dreamOutcome !== null && h.polyOutcome !== null && h.dreamOutcome !== h.polyOutcome);
  const last = [...scored].reverse().slice(0, 10);
  return (
    <div className="panel">
      <h3>Who called it</h3>
      <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 13 }}>
        When a window rolls over, the last price each venue showed before the close is kept. Once each venue settles on its own oracle, that price is scored against the outcome.
        Lower Brier is better; 0.25 is a coin flip. Scores accumulate in this browser while the page is open.
      </p>
      <div className="grid" style={{ marginTop: 0 }}>
        <div className="venue">
          <div className="vn">
            <span>DreamDEX</span>
            <span>{d.n} windows</span>
          </div>
          <div className="mid">
            {d.b === null ? "—" : d.b.toFixed(3)}
            <small>Brier</small>
          </div>
          <div className="bo">
            <span>
              called the side <b>{d.n ? `${d.hit}/${d.n}` : "—"}</b>
            </span>
            <span>
              <b>{d.n ? `${Math.round((100 * d.hit) / d.n)}%` : "—"}</b>
            </span>
          </div>
        </div>
        <div className="venue">
          <div className="vn">
            <span>Polymarket</span>
            <span>{p.n} windows</span>
          </div>
          <div className="mid">
            {p.b === null ? "—" : p.b.toFixed(3)}
            <small>Brier</small>
          </div>
          <div className="bo">
            <span>
              called the side <b>{p.n ? `${p.hit}/${p.n}` : "—"}</b>
            </span>
            <span>
              <b>{p.n ? `${Math.round((100 * p.hit) / p.n)}%` : "—"}</b>
            </span>
          </div>
        </div>
      </div>
      {disagree.length > 0 && (
        <div className="edge down" style={{ marginTop: 12 }}>
          <span>
            The two oracles settled <b>{disagree.length}</b> window{disagree.length > 1 ? "s" : ""} on opposite sides: {disagree.map((h) => `${h.series} ${hhmm(h.end)}`).join(", ")}. Different
            reference price, different answer.
          </span>
        </div>
      )}
      <table className="tbl" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>window</th>
            <th className="r">DreamDEX last</th>
            <th className="r">DreamDEX settled</th>
            <th className="r">Polymarket last</th>
            <th className="r">Polymarket settled</th>
            <th className="r">Brier D / P</th>
          </tr>
        </thead>
        <tbody>
          {last.map((h) => (
            <tr key={h.key}>
              <td>
                {h.series} · {hhmm(h.start)}→{hhmm(h.end)}
              </td>
              <td className="r">{cents(h.dreamLast)}</td>
              <td className="r">{h.dreamOutcome === null ? "…" : h.dreamOutcome ? "UP" : "DOWN"}</td>
              <td className="r">{cents(h.polyLast)}</td>
              <td className="r">{h.polyOutcome === null ? "…" : h.polyOutcome ? "UP" : "DOWN"}</td>
              <td className="r">
                {brier(h.dreamLast, h.dreamOutcome)?.toFixed(3) ?? "—"} / {brier(h.polyLast, h.polyOutcome)?.toFixed(3) ?? "—"}
              </td>
            </tr>
          ))}
          {last.length === 0 && (
            <tr>
              <td colSpan={6} style={{ color: "var(--muted)" }}>
                No settled windows yet. Leave the page open across a window close.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
