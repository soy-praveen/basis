// Basis quoting bot: makes a DreamDEX window track Polymarket's price for the same
// window. Every cycle it reads the Polymarket Up mid, cancels its resting DreamDEX
// quotes, and rests a post-only bid and ask around that mid. Fills are real
// DreamDEX positions; the Polymarket hedge is tracked on paper in the log so the
// basis P&L is visible without a Polygon wallet.
//
//   SERIES=BTC/300 SPREAD=0.02 SIZE=20 node bot/quote.mjs
import { parseAbi, formatUnits } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaTestnet } from "viem/chains";
import { config } from "dotenv";
config();

const RPC = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const pub = createPublicClient({ chain: somniaTestnet, transport: http(RPC, { batch: true }), batch: { multicall: true } });
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const wallet = createWalletClient({ chain: somniaTestnet, transport: http(RPC), account });
const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388";
const COLLATERAL = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";
const [ASSET, INTERVAL] = (process.env.SERIES || "BTC/300").split("/");
const SPREAD = Number(process.env.SPREAD || 0.02); // half-spread each side of the Polymarket mid
const SIZE = Number(process.env.SIZE || 20); // contracts per side
const REQUOTE_MS = Number(process.env.REQUOTE_MS || 20000);
const STOP_BEFORE = Number(process.env.STOP_BEFORE_SEC || 45); // pull quotes this long before close

const marketCreatedEvent = {
  type: "event",
  name: "MarketCreated",
  inputs: [
    { name: "marketId", type: "bytes32", indexed: true }, { name: "market", type: "address", indexed: true }, { name: "pool", type: "address", indexed: true },
    { name: "oracleQuestionId", type: "uint256", indexed: false }, { name: "operatorId", type: "uint32", indexed: false }, { name: "venueId", type: "bytes32", indexed: false },
    { name: "creator", type: "address", indexed: false }, { name: "collateral", type: "address", indexed: false }, { name: "yesId", type: "uint256", indexed: false },
    { name: "noId", type: "uint256", indexed: false }, { name: "nonce", type: "uint64", indexed: false }, { name: "outcomeSlotCount", type: "uint8", indexed: false },
    { name: "marketType", type: "uint8", indexed: false }, { name: "tradingStart", type: "uint64", indexed: false }, { name: "expiry", type: "uint64", indexed: false },
    { name: "voidPolicy", type: "uint8", indexed: false }, { name: "asset", type: "string", indexed: false }, { name: "strike", type: "uint256", indexed: false },
    { name: "question", type: "string", indexed: false }, { name: "context", type: "bytes", indexed: false },
  ],
};
const poolAbi = parseAbi([
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function marketExpiryNs() view returns (uint64)",
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
  "function cancelOrder(uint128 orderId)",
  "function getOwnOpenOrders() view returns (uint128[])",
  "function mintSet(address yesTo, address noTo, uint256 amount)",
]);
const erc20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
const erc6909 = parseAbi(["function balanceOf(address owner, uint256 id) view returns (uint256)", "function isOperator(address owner, address spender) view returns (bool)", "function setOperator(address spender, bool approved) returns (bool)"]);
const OUTCOME = "0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

async function send(req, label) {
  const fees = await pub.estimateFeesPerGas();
  const gas = await pub.estimateContractGas({ ...req, account });
  const hash = await wallet.writeContract({ ...req, gas: (gas * 15n) / 10n, maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted ${hash}`);
  log(`${label} ok ${hash}`);
  return r;
}

async function currentWindow() {
  const t = now();
  const start = Math.floor(t / Number(INTERVAL)) * Number(INTERVAL);
  const end = start + Number(INTERVAL);
  const head = await pub.getBlockNumber();
  const pages = await Promise.all([0, 1, 2].map((i) => pub.getLogs({ address: MODULE, event: marketCreatedEvent, fromBlock: head - BigInt(i * 1000) - 999n, toBlock: head - BigInt(i * 1000) }).catch(() => [])));
  const m = pages.flat().map((l) => l.args).find((a) => a.asset === ASSET && Number(a.expiry) === end && a.collateral.toLowerCase() === COLLATERAL.toLowerCase());
  return m ? { ...m, start, end } : null;
}

async function polyMid(start) {
  const slug = `${ASSET.toLowerCase()}-updown-${Number(INTERVAL) / 60}m-${start}`;
  const ev = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`).then((r) => r.json()).catch(() => null);
  const mk = ev?.[0]?.markets?.[0];
  if (!mk) return null;
  const [up] = JSON.parse(mk.clobTokenIds || "[]");
  const book = await fetch(`https://clob.polymarket.com/book?token_id=${up}`).then((r) => r.json()).catch(() => null);
  if (!book) return null;
  const bid = Math.max(0, ...(book.bids || []).map((l) => Number(l.price)));
  const ask = Math.min(1, ...(book.asks || []).map((l) => Number(l.price)));
  if (bid <= 0 && ask >= 1) return null;
  return bid > 0 && ask < 1 ? (bid + ask) / 2 : bid > 0 ? bid : ask;
}

let paper = { fillsUp: 0, fillsDown: 0, hedged: 0 };
let lastWindow = null;
let held = { yes: 0n, no: 0n };

async function ensureInventory(m, ob) {
  // Selling needs inventory: mint a set of SIZE contracts once per window so the ask side has tokens.
  const yes = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [account.address, m.yesId] });
  if (yes >= BigInt(SIZE) * 1_000_000n) return;
  const need = BigInt(SIZE) * 1_000_000n;
  const allowance = await pub.readContract({ address: COLLATERAL, abi: erc20, functionName: "allowance", args: [account.address, m.pool] });
  if (allowance < need * 2n) await send({ address: COLLATERAL, abi: erc20, functionName: "approve", args: [m.pool, 2n ** 255n] }, "approve pool");
  const isOp = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "isOperator", args: [account.address, m.pool] });
  if (!isOp) await send({ address: OUTCOME, abi: erc6909, functionName: "setOperator", args: [m.pool, true] }, "setOperator(pool)");
  await send({ address: m.pool, abi: poolAbi, functionName: "mintSet", args: [account.address, account.address, need] }, `mintSet ${SIZE}`);
}

async function cancelAll(pool) {
  const ids = await pub.readContract({ address: pool, abi: poolAbi, functionName: "getOwnOpenOrders", account }).catch(() => []);
  for (const id of ids) {
    try {
      await send({ address: pool, abi: poolAbi, functionName: "cancelOrder", args: [id] }, `cancel ${id}`);
    } catch (e) {
      log(`cancel ${id} failed: ${(e.shortMessage || e.message).split("\n")[0]}`);
    }
  }
}

async function cycle() {
  const m = await currentWindow();
  if (!m) {
    log(`no DreamDEX ${ASSET} ${INTERVAL}s window on chain yet`);
    return;
  }
  const t = now();
  if (m.end - t < STOP_BEFORE) {
    if (lastWindow === m.marketId) {
      await cancelAll(m.pool);
      lastWindow = null;
      log(`pulled quotes ${m.end - t}s before close`);
    }
    return;
  }
  const mid = await polyMid(m.start);
  if (mid === null) {
    log("no Polymarket mid yet");
    return;
  }
  const ob = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "getOrderBookParameters" });
  const tick = Number(ob.tickSize) / 1e6;
  const bid = Math.max(tick, Math.floor((mid - SPREAD) / tick) * tick);
  const ask = Math.min(1 - tick, Math.ceil((mid + SPREAD) / tick) * tick);
  const [dBids, dAsks] = await Promise.all([
    pub.readContract({ address: m.pool, abi: poolAbi, functionName: "getBookLevels", args: [true, 1n] }),
    pub.readContract({ address: m.pool, abi: poolAbi, functionName: "getBookLevels", args: [false, 1n] }),
  ]);
  const dBid = dBids[0] ? Number(dBids[0].price) / 1e6 : null, dAsk = dAsks[0] ? Number(dAsks[0].price) / 1e6 : null;
  log(`${ASSET} ${m.start % 3600 / 60}m window · poly mid ${(mid * 100).toFixed(1)}¢ · dream ${dBid !== null ? (dBid * 100).toFixed(1) : "—"}/${dAsk !== null ? (dAsk * 100).toFixed(1) : "—"}¢ · quoting ${(bid * 100).toFixed(1)}/${(ask * 100).toFixed(1)}¢`);

  if (lastWindow !== m.marketId) {
    await ensureInventory(m, ob);
    lastWindow = m.marketId;
  }
  await cancelAll(m.pool);
  const yesBefore = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [account.address, m.yesId] });
  const expNs = await pub.readContract({ address: m.pool, abi: poolAbi, functionName: "marketExpiryNs" });
  const qty = BigInt(SIZE) * 1_000_000n;
  const px = (p) => (BigInt(Math.round(p * 1e6)) / ob.tickSize) * ob.tickSize;
  for (const [kind, p, label] of [[0, bid, "bid"], [1, ask, "ask"]]) {
    // post-only: a quote that would cross reverts; skip it rather than take liquidity
    if (label === "bid" && dAsk !== null && p >= dAsk) { log("bid would cross, skipped"); continue; }
    if (label === "ask" && dBid !== null && p <= dBid) { log("ask would cross, skipped"); continue; }
    try {
      await send({ address: m.pool, abi: poolAbi, functionName: "placeBinaryOrder", args: [kind, px(p), qty, expNs, 3, 0, "0x0000000000000000000000000000000000000000", 0n, 0n] }, `rest ${label} ${SIZE} @ ${(p * 100).toFixed(1)}¢`);
    } catch (e) {
      log(`${label} failed: ${(e.shortMessage || e.message).split("\n")[0]}`);
    }
  }
  const yesAfter = await pub.readContract({ address: OUTCOME, abi: erc6909, functionName: "balanceOf", args: [account.address, m.yesId] });
  const delta = Number(yesAfter - yesBefore) / 1e6;
  if (delta !== 0) {
    paper.hedged += -delta * mid; // hedge on Polymarket at its mid, on paper
    log(`fill: ${delta > 0 ? "bought" : "sold"} ${Math.abs(delta)} Up on DreamDEX; paper-hedged on Polymarket at ${(mid * 100).toFixed(1)}¢`);
  }
}

log(`basis quoter ${account.address} · ${ASSET}/${INTERVAL}s · half-spread ${SPREAD} · size ${SIZE}`);
for (;;) {
  try {
    await cycle();
  } catch (e) {
    log(`cycle failed: ${(e.shortMessage || e.message).split("\n")[0]}`);
  }
  await sleep(REQUOTE_MS);
}
