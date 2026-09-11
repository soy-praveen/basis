// DreamDEX Event Contracts on Somnia Shannon: live windows and their order books.
import { createPublicClient, createWalletClient, custom, http, parseAbi, type Address, type Hex, type WalletClient } from "viem";
import { somniaTestnet } from "viem/chains";

export const chain = somniaTestnet;
export const RPC = "https://dream-rpc.somnia.network";
export const EXPLORER = "https://shannon-explorer.somnia.network";
export const pub = createPublicClient({ chain, transport: http(RPC, { batch: true }), batch: { multicall: true } });

export const MODULE: Address = "0x3ecC694Cef705358864a646142ac17A90E29e388";
export const COLLATERAL: Address = "0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E";

export const marketCreatedEvent = {
  type: "event",
  name: "MarketCreated",
  inputs: [
    { name: "marketId", type: "bytes32", indexed: true },
    { name: "market", type: "address", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "oracleQuestionId", type: "uint256", indexed: false },
    { name: "operatorId", type: "uint32", indexed: false },
    { name: "venueId", type: "bytes32", indexed: false },
    { name: "creator", type: "address", indexed: false },
    { name: "collateral", type: "address", indexed: false },
    { name: "yesId", type: "uint256", indexed: false },
    { name: "noId", type: "uint256", indexed: false },
    { name: "nonce", type: "uint64", indexed: false },
    { name: "outcomeSlotCount", type: "uint8", indexed: false },
    { name: "marketType", type: "uint8", indexed: false },
    { name: "tradingStart", type: "uint64", indexed: false },
    { name: "expiry", type: "uint64", indexed: false },
    { name: "voidPolicy", type: "uint8", indexed: false },
    { name: "asset", type: "string", indexed: false },
    { name: "strike", type: "uint256", indexed: false },
    { name: "question", type: "string", indexed: false },
    { name: "context", type: "bytes", indexed: false },
  ],
} as const;

export const poolAbi = parseAbi([
  "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
  "function getOrderBookParameters() view returns ((uint256 tickSize, uint256 minQuantity, uint256 lotSize))",
  "function marketExpiryNs() view returns (uint64)",
  "function placeBinaryOrder(uint8 kind, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k, uint64 userData) payable returns (bool success, uint128 id)",
]);
export const marketAbi = parseAbi(["function isResolved() view returns (bool)", "function isVoided() view returns (bool)", "function payoutNumerators() view returns (uint256[])"]);
export const erc20Abi = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export type DreamWindow = {
  marketId: Hex;
  market: Address;
  pool: Address;
  asset: string;
  strike: number; // 2-decimal price, 0 if unknown
  question: string;
  tradingStart: number;
  expiry: number;
  intervalSec: number;
};

export type Level = { price: number; quantity: number };
export type DreamBook = { bids: Level[]; asks: Level[]; tick: bigint; lot: bigint; min: bigint };

const seen = new Map<string, DreamWindow>();
let scanned = false;

/** Scan recent MarketCreated logs and return live tUSDC windows keyed by asset+interval+expiry. */
export async function fetchDreamWindows(pages = 2): Promise<DreamWindow[]> {
  // a 15-minute window is created ~9400 blocks before it closes, so the first scan goes deep
  if (!scanned) {
    pages = 12;
    scanned = true;
  }
  const head = await pub.getBlockNumber();
  const ranges = Array.from({ length: pages }, (_, i) => [head - BigInt(i * 1000) - 999n, head - BigInt(i * 1000)] as [bigint, bigint]);
  const res = await Promise.all(ranges.map(([a, b]) => pub.getLogs({ address: MODULE, event: marketCreatedEvent, fromBlock: a, toBlock: b }).catch(() => [])));
  for (const logs of res) {
    for (const l of logs as any[]) {
      const a = l.args;
      if ((a.collateral || "").toLowerCase() !== COLLATERAL.toLowerCase()) continue;
      const tradingStart = Number(a.tradingStart), expiry = Number(a.expiry);
      const intervalSec = Math.max(60, Math.round((expiry - tradingStart) / 60) * 60);
      seen.set(a.marketId, {
        marketId: a.marketId,
        market: a.market,
        pool: a.pool,
        asset: a.asset,
        strike: Number(a.strike) / 100,
        question: a.question,
        tradingStart,
        expiry,
        intervalSec,
      });
    }
  }
  const now = Math.floor(Date.now() / 1000);
  return [...seen.values()].filter((w) => w.expiry > now - 120).sort((a, b) => a.expiry - b.expiry);
}

export async function fetchDreamBook(pool: Address): Promise<DreamBook> {
  const [bids, asks, ob] = await Promise.all([
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getBookLevels", args: [true, 6n] }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getBookLevels", args: [false, 6n] }),
    pub.readContract({ address: pool, abi: poolAbi, functionName: "getOrderBookParameters" }),
  ]);
  const norm = (x: readonly { price: bigint; quantity: bigint }[]) => x.map((l) => ({ price: Number(l.price) / 1e6, quantity: Number(l.quantity) / 1e6 }));
  return { bids: norm(bids), asks: norm(asks), tick: ob.tickSize, lot: ob.lotSize, min: ob.minQuantity };
}

export const dreamMid = (b: DreamBook | null): number | null => {
  if (!b) return null;
  const bid = b.bids[0]?.price, ask = b.asks[0]?.price;
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  return bid ?? ask ?? null;
};

// ---------------------------------------------------------------- wallet

export type Wallet = { address: Address; client: WalletClient };
declare global {
  interface Window {
    ethereum?: any;
  }
}
export async function connectWallet(): Promise<Wallet> {
  const eth = window.ethereum;
  if (!eth) throw new Error("No injected wallet found.");
  const [address] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
  const hexId = `0x${chain.id.toString(16)}`;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (e: any) {
    if (e?.code === 4902 || /4902|unrecognized|not added/i.test(String(e?.message))) {
      await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: hexId, chainName: "Somnia Shannon Testnet", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: [RPC], blockExplorerUrls: [EXPLORER] }] });
    } else throw e;
  }
  return { address, client: createWalletClient({ chain, transport: custom(eth), account: address }) };
}
export async function silentWallet(): Promise<Wallet | null> {
  const eth = window.ethereum;
  if (!eth) return null;
  try {
    const accounts = (await eth.request({ method: "eth_accounts" })) as Address[];
    if (!accounts?.length) return null;
    return { address: accounts[0], client: createWalletClient({ chain, transport: custom(eth), account: accounts[0] }) };
  } catch {
    return null;
  }
}

async function write(w: Wallet, address: Address, abi: any, functionName: string, args: unknown[]): Promise<Hex> {
  const gas = await pub.estimateContractGas({ address, abi, functionName, args, account: w.address });
  const hash = await w.client.writeContract({ address, abi, functionName, args, account: w.address, chain, gas: (gas * 13n) / 10n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error("Transaction reverted");
  return hash;
}

/** Take liquidity on DreamDEX: IOC buy of `side` (0 up, 1 down) for `contracts` at up to `limit` (YES-side price). */
export async function takeOnDream(w: Wallet, win: DreamWindow, side: 0 | 1, contracts: number, limitYesPrice: number, book: DreamBook): Promise<Hex> {
  const qtyRaw = (BigInt(Math.floor(contracts * 1e6)) / book.lot) * book.lot;
  if (qtyRaw < book.min) throw new Error("Size below the venue minimum");
  const priceRaw = (BigInt(Math.round(limitYesPrice * 1e6)) / book.tick) * book.tick;
  const need = side === 0 ? (qtyRaw * priceRaw) / 1_000_000n : (qtyRaw * (1_000_000n - priceRaw)) / 1_000_000n;
  const allowance = await pub.readContract({ address: COLLATERAL, abi: erc20Abi, functionName: "allowance", args: [w.address, win.pool] });
  if (allowance < need) await write(w, COLLATERAL, erc20Abi, "approve", [win.pool, 2n ** 255n]);
  const expNs = await pub.readContract({ address: win.pool, abi: poolAbi, functionName: "marketExpiryNs" });
  return write(w, win.pool, poolAbi, "placeBinaryOrder", [side === 0 ? 0 : 2, priceRaw, qtyRaw, expNs, 2, 0, "0x0000000000000000000000000000000000000000", 0n, 0n]);
}

export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrUrl = (a: string) => `${EXPLORER}/address/${a}`;
