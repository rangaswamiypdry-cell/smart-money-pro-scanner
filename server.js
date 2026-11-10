// =====================================================
// SMART MONEY PRO SCANNER V3
// PART 1 / 2
// INDEX + OPTIONS MOMENTUM ENGINE
// NODE JS 20+ | UPSTOX V3
// =====================================================

"use strict";

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);

const TOKEN =
  process.env.UPSTOX_ACCESS_TOKEN || "";

const API_BASE =
  "https://api.upstox.com";

const CACHE_MS = 15000;

const CANDLE_INTERVAL = 5;

const MIN_CANDLES = 21;

const VOLUME_MULTIPLIER = 2;

const REQUEST_TIMEOUT = 15000;

// =====================================================
// INDEX CONFIGURATION
// =====================================================

const INDEXES = {

  NIFTY: {
    name: "NIFTY 50",
    exchange: "NSE",
    key:
      process.env.NIFTY_INDEX_KEY ||
      "NSE_INDEX|Nifty 50"
  },

  BANKNIFTY: {
    name: "BANK NIFTY",
    exchange: "NSE",
    key:
      process.env.BANKNIFTY_INDEX_KEY ||
      "NSE_INDEX|Nifty Bank"
  },

  SENSEX: {
    name: "SENSEX",
    exchange: "BSE",
    key:
      process.env.SENSEX_INDEX_KEY ||
      "BSE_INDEX|SENSEX"
  },

  FINNIFTY: {
    name: "FINNIFTY",
    exchange: "NSE",
    key:
      process.env.FINNIFTY_INDEX_KEY ||
      "NSE_INDEX|Nifty Fin Service"
  },

  MIDCPNIFTY: {
    name: "MIDCAP NIFTY",
    exchange: "NSE",
    key:
      process.env.MIDCPNIFTY_INDEX_KEY ||
      "NSE_INDEX|Nifty Midcap Select"
  }

};

// =====================================================
// GLOBAL CACHE
// =====================================================

const cache = new Map();

const optionHistory = new Map();

// =====================================================
// JSON RESPONSE
// =====================================================

function send(res, status, data) {

  res.writeHead(status, {

    "Content-Type":
      "application/json; charset=utf-8",

    "Access-Control-Allow-Origin": "*",

    "Access-Control-Allow-Methods":
      "GET,OPTIONS",

    "Access-Control-Allow-Headers":
      "Content-Type,Authorization",

    "Cache-Control": "no-store"

  });

  res.end(JSON.stringify(data));

}

// =====================================================
// API REQUEST VALIDATION
// =====================================================

async function upstoxGet(path) {

  if (!TOKEN) {

    throw new Error(
      "UPSTOX_ACCESS_TOKEN missing"
    );

  }

  const response = await fetch(

    `${API_BASE}${path}`,

    {

      method: "GET",

      headers: {

        "Accept": "application/json",

        "Authorization":
          `Bearer ${TOKEN}`

      },

      signal:
        AbortSignal.timeout(REQUEST_TIMEOUT)

    }

  );

  const body = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {

    const error = new Error(

      body?.errors?.[0]?.message ||

      body?.message ||

      `Upstox HTTP ${response.status}`

    );

    error.status = response.status;

    error.details = body;

    throw error;

  }

  if (body.status && body.status !== "success") {

    throw new Error(
      "Invalid Upstox API response"
    );

  }

  return body;

}

// =====================================================
// INSTRUMENT KEY VALIDATION
// =====================================================

function validateInstrumentKey(key) {

  if (
    typeof key !== "string" ||
    !key.includes("|") ||
    key.length < 5
  ) {

    throw new Error(
      "Invalid instrument key: " + key
    );

  }

  return true;

}

// =====================================================
// GET 5 MINUTE CANDLES
// =====================================================

async function getCandles(instrumentKey) {

  validateInstrumentKey(instrumentKey);

  const path =

    `/v3/historical-candle/intraday/` +

    `${encodeURIComponent(instrumentKey)}` +

    `/minutes/${CANDLE_INTERVAL}`;

  const json = await upstoxGet(path);

  const rows = json?.data?.candles;

  if (!Array.isArray(rows)) {

    throw new Error(
      "Candle data missing from Upstox"
    );

  }

  return rows;

}

// =====================================================
// COMPLETED CANDLE FILTER
// =====================================================

function completedCandles(rows) {

  const now = Date.now();

  return rows

    .filter(row => {

      if (
        !Array.isArray(row) ||
        row.length < 6
      ) {

        return false;

      }

      const time =
        new Date(row[0]).getTime();

      return (

        Number.isFinite(time) &&

        time + 300000 <= now

      );

    })

    .map(row => ({

      time: row[0],

      open: Number(row[1]),

      high: Number(row[2]),

      low: Number(row[3]),

      close: Number(row[4]),

      volume: Number(row[5] || 0),

      oi: Number(row[6] || 0)

    }))

    .filter(c =>

      [

        c.open,

        c.high,

        c.low,

        c.close,

        c.volume

      ].every(Number.isFinite)

    )

    .sort((a, b) =>

      new Date(a.time) -
      new Date(b.time)

    );

}

// =====================================================
// AVERAGE
// =====================================================

function average(values) {

  if (!values.length) return 0;

  return values.reduce(

    (sum, value) => sum + value,

    0

  ) / values.length;

}

// =====================================================
// EMA 20
// =====================================================

function calculateEMA(values, period = 20) {

  if (values.length < period) {

    return null;

  }

  const multiplier =
    2 / (period + 1);

  let result = average(
    values.slice(0, period)
  );

  for (
    let i = period;
    i < values.length;
    i++
  ) {

    result =

      values[i] * multiplier +

      result * (1 - multiplier);

  }

  return result;

}

// =====================================================
// RSI WILDER
// =====================================================

function calculateRSI(values, period = 14) {

  if (values.length <= period) {

    return null;

  }

  let gains = 0;

  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const change =
      values[i] - values[i - 1];

    if (change > 0) {

      gains += change;

    } else {

      losses += Math.abs(change);

    }

  }

  let avgGain = gains / period;

  let avgLoss = losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {

    const change =
      values[i] - values[i - 1];

    avgGain = (

      avgGain * (period - 1) +

      Math.max(change, 0)

    ) / period;

    avgLoss = (

      avgLoss * (period - 1) +

      Math.max(-change, 0)

    ) / period;

  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));

}

// =====================================================
// VWAP
// =====================================================

function calculateVWAP(candles) {

  let totalPV = 0;

  let totalVolume = 0;

  for (const candle of candles) {

    const typicalPrice = (

      candle.high +

      candle.low +

      candle.close

    ) / 3;

    totalPV +=

      typicalPrice * candle.volume;

    totalVolume += candle.volume;

  }

  if (totalVolume <= 0) {

    return null;

  }

  return totalPV / totalVolume;

}

// =====================================================
// VOLUME ANALYSIS
// =====================================================

function calculateVolumeRatio(candles) {

  if (candles.length < 21) {

    return 0;

  }

  const previous =

    candles.slice(-21, -1);

  const avgVolume = average(

    previous.map(c => c.volume)

  );

  const latest =

    candles[candles.length - 1];

  if (avgVolume <= 0) {

    return 0;

  }

  return latest.volume / avgVolume;

}

// =====================================================
// PRICE MOMENTUM
// =====================================================

function calculateMomentum(candles) {

  if (candles.length < 3) {

    return null;

  }

  const last =
    candles[candles.length - 1];

  const prev =
    candles[candles.length - 2];

  const change =

    last.close - prev.close;

  const percentage =

    prev.close > 0

      ? (change / prev.close) * 100

      : 0;

  return {

    change,

    percentage,

    bullish: change > 0,

    bearish: change < 0

  };

}

// =====================================================
// OPTIONS CONFIGURATION
// =====================================================

const OPTION_CONFIG = {

  expiry: "current_week",

  strikesEachSide: 2,

  minPremium: 5,

  minVolume: 1,

  minOI: 1,

  minScore: 4,

  strongScore: 5,

  rsiBullish: 65,

  rsiBearish: 35,

  volumeMultiplier: 2

};

// =====================================================
// FUTURES INSTRUMENT KEYS
// =====================================================

const FUTURES_KEYS = {

  NIFTY:
    process.env.NIFTY_FUTURES_KEY || "",

  BANKNIFTY:
    process.env.BANKNIFTY_FUTURES_KEY || "",

  SENSEX:
    process.env.SENSEX_FUTURES_KEY || "",

  FINNIFTY:
    process.env.FINNIFTY_FUTURES_KEY || "",

  MIDCPNIFTY:
    process.env.MIDCPNIFTY_FUTURES_KEY || ""

};

// =====================================================
// GET OPTION CHAIN
// =====================================================

async function getOptionChain(symbol) {

  const config = INDEXES[symbol];

  if (!config) {

    throw new Error("Unknown index: " + symbol);

  }

  const params = new URLSearchParams({

    instrument_key: config.key,

    expiry_date: OPTION_CONFIG.expiry

  });

  const json = await upstoxGet(

    `/v2/option/chain?${params.toString()}`

  );

  if (!Array.isArray(json.data)) {

    throw new Error(
      "Invalid option chain response"
    );

  }

  return json.data;

}

// =====================================================
// GET FUTURES DATA
// =====================================================

async function getFuturesData(symbol) {

  const key = FUTURES_KEYS[symbol];

  if (!key) {

    return {

      available: false,

      reason: "Futures key not configured"

    };

  }

  try {

    const rows = await getCandles(key);

    const candles = completedCandles(rows);

    if (candles.length < 2) {

      return {

        available: false,

        reason: "Insufficient futures candles"

      };

    }

    const last = candles[candles.length - 1];

    const prev = candles[candles.length - 2];

    const oiChange =

      prev.oi > 0

        ? ((last.oi - prev.oi) / prev.oi) * 100

        : null;

    return {

      available: last.oi > 0 && prev.oi > 0,

      lastOI: last.oi,

      previousOI: prev.oi,

      oiChangePct: oiChange,

      priceChange:

        last.close - prev.close,

      longBuildUp:

        oiChange !== null &&

        oiChange > 0 &&

        last.close > prev.close,

      shortBuildUp:

        oiChange !== null &&

        oiChange > 0 &&

        last.close < prev.close

    };

  } catch (error) {

    return {

      available: false,

      reason: error.message

    };

  }

}

// =====================================================
// OPTION CANDLE ANALYSIS
// =====================================================

function analyseOption(key, side, marketData) {

  const candles = completedCandles(
    marketData.candles
  );

  if (candles.length < MIN_CANDLES) {

    return {

      ready: false,

      reason: "Insufficient option candles"

    };

  }

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];

  const prev = candles[candles.length - 2];

  const rsiValue = calculateRSI(closes, 14);

  const emaValue = calculateEMA(closes, 20);

  const currentVWAP = calculateVWAP(candles);

  const previousVWAP = calculateVWAP(
    candles.slice(0, -1)
  );

  const volumeRatio =
    calculateVolumeRatio(candles);

  const bullishCross =

    currentVWAP !== null &&

    previousVWAP !== null &&

    last.close > currentVWAP &&

    prev.close <= previousVWAP;

  const bearishCross =

    currentVWAP !== null &&

    previousVWAP !== null &&

    last.close < currentVWAP &&

    prev.close >= previousVWAP;

  const premiumRising =

    last.close > prev.close;

  const premiumFalling =

    last.close < prev.close;

  const bullishTrend =

    emaValue !== null &&

    last.close > emaValue;

  const bearishTrend =

    emaValue !== null &&

    last.close < emaValue;

  const bullishRSI =

    rsiValue !== null &&

    rsiValue >= OPTION_CONFIG.rsiBullish;

  const bearishRSI =

    rsiValue !== null &&

    rsiValue <= OPTION_CONFIG.rsiBearish;

  const volumePass =

    volumeRatio >=
    OPTION_CONFIG.volumeMultiplier;

  const oi = marketData.oi || 0;

  const previousOI =
    marketData.prev_oi || 0;

  const oiIncreasing =

    oi > 0 &&

    previousOI > 0 &&

    oi > previousOI;

  const oiChangePct =

    previousOI > 0

      ? ((oi - previousOI) / previousOI) * 100

      : null;

  let score = 0;

  if (side === "CE") {

    score += bullishRSI ? 1 : 0;

    score += bullishTrend ? 1 : 0;

    score += bullishCross ? 1 : 0;

    score += volumePass ? 1 : 0;

    score += premiumRising ? 1 : 0;

    score += oiIncreasing ? 1 : 0;

  } else {

    score += bearishRSI ? 1 : 0;

    score += bearishTrend ? 1 : 0;

    score += bearishCross ? 1 : 0;

    score += volumePass ? 1 : 0;

    score += premiumRising ? 1 : 0;

    score += oiIncreasing ? 1 : 0;

  }

  const signal =

    score >= OPTION_CONFIG.strongScore

      ? side === "CE"
        ? "STRONG_CALL"
        : "STRONG_PUT"

      : score >= OPTION_CONFIG.minScore

        ? side === "CE"
          ? "CALL_WATCH"
          : "PUT_WATCH"

        : "WAIT";

  return {

    ready: true,

    side,

    instrumentKey: key,

    signal,

    score: `${score}/6`,

    ltp: last.close,

    rsi: Number(rsiValue.toFixed(2)),

    ema20: Number(emaValue.toFixed(2)),

    vwap: Number(currentVWAP.toFixed(2)),

    volume: last.volume,

    volumeRatio: Number(volumeRatio.toFixed(2)),

    oi,

    previousOI,

    oiChangePct,

    oiIncreasing,

    vwapCross:

      side === "CE"
        ? bullishCross
        : bearishCross,

    premiumRising,

    candleTime: last.time

  };

}

// =====================================================
// BUILD STRIKE LIST
// =====================================================

function selectStrikeRows(chain) {

  if (!chain.length) {

    return [];

  }

  const spot = Number(
    chain[0].underlying_spot_price
  );

  if (!Number.isFinite(spot) || spot <= 0) {

    return [];

  }

  const strikes = [

    ...new Set(

      chain

        .map(x => Number(x.strike_price))

        .filter(x => Number.isFinite(x) && x > 0)

    )

  ].sort((a, b) => a - b);

  if (!strikes.length) return [];

  let atmIndex = 0;

  for (let i = 1; i < strikes.length; i++) {

    if (

      Math.abs(strikes[i] - spot) <

      Math.abs(strikes[atmIndex] - spot)

    ) {

      atmIndex = i;

    }

  }

  const selected = strikes.slice(

    Math.max(
      0,
      atmIndex - OPTION_CONFIG.strikesEachSide
    ),

    Math.min(

      strikes.length,

      atmIndex + OPTION_CONFIG.strikesEachSide + 1

    )

  );

  return chain.filter(row =>

    selected.includes(Number(row.strike_price))

  );

}

// =====================================================
// GET OPTION CANDIDATES
// =====================================================

async function analyseStrike(row, symbol) {

  const results = [];

  const spot = Number(
    row.underlying_spot_price
  );

  const strike = Number(row.strike_price);

  const options = [

    {

      side: "CE",

      data: row.call_options

    },

    {

      side: "PE",

      data: row.put_options

    }

  ];

  for (const item of options) {

    const option = item.data;

    if (!option?.instrument_key) continue;

    const md = option.market_data || {};

    const ltp = Number(md.ltp || 0);

    const volume = Number(md.volume || 0);

    const oi = Number(md.oi || 0);

    const prevOI = Number(md.prev_oi || 0);

    if (

      ltp < OPTION_CONFIG.minPremium ||

      volume < OPTION_CONFIG.minVolume ||

      oi < OPTION_CONFIG.minOI

    ) {

      continue;

    }

    try {

      const rows = await getCandles(
        option.instrument_key
      );

      const analysis = analyseOption(

        option.instrument_key,

        item.side,

        {

          candles: rows,

          oi,

          prev_oi: prevOI

        }

      );

      if (!analysis.ready) continue;

      results.push({

        index: symbol,

        indexName: INDEXES[symbol].name,

        spot,

        strike,

        expiry: row.expiry,

        optionType: item.side,

        instrumentKey: option.instrument_key,

        tradingPremium: ltp,

        optionVolume: volume,

        optionOI: oi,

        previousOI: prevOI,

        ...analysis

      });

    } catch (error) {

      results.push({

        index: symbol,

        strike,

        optionType: item.side,

        status: "ERROR",

        message: error.message

      });

    }

  }

  return results;

}

// =====================================================
// SMART MONEY SCORE
// =====================================================

function finalSmartMoneyScore(option, futures) {

  let score = Number(
    String(option.score).split("/")[0]
  );

  if (futures.available) {

    if (

      option.optionType === "CE" &&

      futures.longBuildUp

    ) {

      score += 1;

    }

    if (

      option.optionType === "PE" &&

      futures.shortBuildUp

    ) {

      score += 1;

    }

  }

  return score;

}

// =====================================================
// SCAN ONE INDEX
// =====================================================

async function scanOptionsIndex(symbol) {

  const config = INDEXES[symbol];

  const [chain, futures] = await Promise.all([

    getOptionChain(symbol),

    getFuturesData(symbol)

  ]);

  const selectedRows = selectStrikeRows(chain);

  if (!selectedRows.length) {

    return {

      symbol,

      status: "WAIT",

      message: "No valid option chain strikes"

    };

  }

  const candidates = [];

  for (const row of selectedRows) {

    const analysed = await analyseStrike(
      row,
      symbol
    );

    candidates.push(...analysed);

  }

  const valid = candidates.filter(
    x => x.ready
  );

  const scored = valid.map(option => ({

    ...option,

    finalScore:
      finalSmartMoneyScore(option, futures)

  }));

  scored.sort(

    (a, b) => b.finalScore - a.finalScore

  );

  const bestCE = scored.find(
    x => x.optionType === "CE"
  ) || null;

  const bestPE = scored.find(
    x => x.optionType === "PE"
  ) || null;

  let selected = null;

  let signal = "WAIT";

  if (

    bestCE &&

    bestCE.finalScore >= OPTION_CONFIG.minScore &&

    bestCE.finalScore >= (bestPE?.finalScore || 0)

  ) {

    selected = bestCE;

    signal = "CALL_BIAS";

  } else if (

    bestPE &&

    bestPE.finalScore >= OPTION_CONFIG.minScore

  ) {

    selected = bestPE;

    signal = "PUT_BIAS";

  }

  return {

    symbol,

    name: config.name,

    status: selected

      ? selected.finalScore >= 6
        ? "VERY_STRONG"
        : "STRONG"

      : "WAIT",

    signal,

    spot: chain[0].underlying_spot_price,

    expiry: chain[0].expiry,

    futures,

    selectedStrike: selected
      ? {

          strike: selected.strike,

          optionType: selected.optionType,

          premium: selected.ltp,

          rsi: selected.rsi,

          ema20: selected.ema20,

          vwap: selected.vwap,

          volume: selected.optionVolume,

          volumeRatio: selected.volumeRatio,

          oi: selected.optionOI,

          oiChangePct: selected.oiChangePct,

          score: selected.finalScore,

          instrumentKey: selected.instrumentKey,

          reason: selected.signal

        }

      : null,

    bestCE,

    bestPE,

    candidates: scored

  };

}

// =====================================================
// SCAN ALL FIVE INDICES
// =====================================================

async function runOptionsScanner() {

  const output = await Promise.all(

    Object.keys(INDEXES).map(async symbol => {

      try {

        return await scanOptionsIndex(symbol);

      } catch (error) {

        return {

          symbol,

          status: "ERROR",

          signal: "DATA_ERROR",

          message: error.message

        };

      }

    })

  );

  return {

    app: "SMART MONEY PRO SCANNER V3",

    timestamp: new Date().toISOString(),

    timeframe: "5 MINUTE",

    indexes: output,

    summary: {

      strong: output.filter(

        x => x.status === "STRONG" ||

             x.status === "VERY_STRONG"

      ).length,

      bullish: output.filter(

        x => x.signal === "CALL_BIAS"

      ).length,

      bearish: output.filter(

        x => x.signal === "PUT_BIAS"

      ).length,

      wait: output.filter(

        x => x.status === "WAIT"

      ).length,

      errors: output.filter(

        x => x.status === "ERROR"

      ).length

    }

  };

}

// =====================================================
// HTTP SERVER
// =====================================================

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {

    res.writeHead(204, {

      "Access-Control-Allow-Origin": "*"

    });

    return res.end();

  }

  const url = new URL(

    req.url,

    `http://${req.headers.host || "localhost"}`

  );

  try {

    // HEALTH

    if (url.pathname === "/health") {

      return send(res, 200, {

        ok: true,

        app: "SMART MONEY PRO SCANNER V3",

        node: process.version,

        tokenConfigured: Boolean(TOKEN),

        indexes: Object.keys(INDEXES)

      });

    }

    // INDEX CONFIG

    if (url.pathname === "/api/scanner/config") {

      return send(res, 200, {

        indexes: Object.keys(INDEXES),

        timeframe: "5m",

        rsiBullish: 65,

        rsiBearish: 35,

        volumeMultiplier: 2,

        expiry: OPTION_CONFIG.expiry

      });

    }

    // OPTIONS SCANNER

    if (url.pathname === "/api/options/scan") {

      const result = await runOptionsScanner();

      return send(res, 200, result);

    }

    // ONE INDEX SCAN

    if (url.pathname === "/api/options/scan/index") {

      const symbol = (

        url.searchParams.get("symbol") || ""

      ).toUpperCase();

      if (!INDEXES[symbol]) {

        return send(res, 400, {

          error: "Invalid index symbol"

        });

      }

      const result =
        await scanOptionsIndex(symbol);

      return send(res, 200, result);

    }

    // OPTION CHAIN

    if (url.pathname === "/api/options/chain") {

      const symbol = (

        url.searchParams.get("symbol") || "NIFTY"

      ).toUpperCase();

      if (!INDEXES[symbol]) {

        return send(res, 400, {

          error: "Invalid index"

        });

      }

      const chain = await getOptionChain(symbol);

      return send(res, 200, {

        symbol,

        expiry: chain[0]?.expiry || null,

        count: chain.length,

        data: chain

      });

    }

    // INDEX CANDLES

    if (url.pathname === "/api/index/candles") {

      const symbol = (

        url.searchParams.get("symbol") || "NIFTY"

      ).toUpperCase();

      if (!INDEXES[symbol]) {

        return send(res, 400, {

          error: "Invalid index"

        });

      }

      const rows = await getCandles(

        INDEXES[symbol].key

      );

      const candles = completedCandles(rows);

      return send(res, 200, {

        symbol,

        instrumentKey: INDEXES[symbol].key,

        rawCandles: rows.length,

        completedCandles: candles.length,

        candles

      });

    }

    // FUTURES STATUS

    if (url.pathname === "/api/futures/status") {

      const output = {};

      for (const symbol of Object.keys(INDEXES)) {

        output[symbol] =
          await getFuturesData(symbol);

      }

      return send(res, 200, output);

    }

    return send(res, 404, {

      error: "Route not found"

    });

  } catch (error) {

    console.error(

      "API ERROR:",

      error.message

    );

    return send(

      res,

      error.status || 500,

      {

        error: error.message,

        details: error.details || undefined

      }

    );

  }

});

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, "0.0.0.0", () => {

  console.log(

    "SMART MONEY PRO SCANNER V3 RUNNING"

  );

  console.log(

    "Port:", PORT

  );

  console.log(

    "Token configured:", Boolean(TOKEN)

  );

});
