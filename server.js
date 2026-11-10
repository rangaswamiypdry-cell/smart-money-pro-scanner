// SMART MONEY PRO INDEX SCANNER V1
// NIFTY + BANKNIFTY + SENSEX + FINNIFTY + MIDCPNIFTY
// UPSTOX API V3 | NODE.JS 20+

"use strict";

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const UPSTOX_BASE = "https://api.upstox.com";
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const CACHE_MS = 30000;
const MIN_CANDLES = 21;

// ========================================
// FIVE INDEX CONFIGURATION
// ========================================

const INDEXES = {
  NIFTY: {
    label: "NIFTY 50",
    exchange: "NSE",
    key: process.env.NIFTY_INDEX_KEY || "NSE_INDEX|Nifty 50",
    futuresKey: process.env.NIFTY_FUTURES_KEY || ""
  },

  BANKNIFTY: {
    label: "BANK NIFTY",
    exchange: "NSE",
    key: process.env.BANKNIFTY_INDEX_KEY || "NSE_INDEX|Nifty Bank",
    futuresKey: process.env.BANKNIFTY_FUTURES_KEY || ""
  },

  SENSEX: {
    label: "SENSEX",
    exchange: "BSE",
    key: process.env.SENSEX_INDEX_KEY || "BSE_INDEX|SENSEX",
    futuresKey: process.env.SENSEX_FUTURES_KEY || ""
  },

  FINNIFTY: {
    label: "FINNIFTY",
    exchange: "NSE",
    key: process.env.FINNIFTY_INDEX_KEY || "NSE_INDEX|Nifty Fin Service",
    futuresKey: process.env.FINNIFTY_FUTURES_KEY || ""
  },

  MIDCPNIFTY: {
    label: "MIDCAP NIFTY",
    exchange: "NSE",
    key: process.env.MIDCPNIFTY_INDEX_KEY || "NSE_INDEX|Nifty Midcap Select",
    futuresKey: process.env.MIDCPNIFTY_FUTURES_KEY || ""
  }
};

const cache = new Map();

// ========================================
// RESPONSE FUNCTION
// ========================================

function send(res, status, data) {

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

// ========================================
// UPSTOX API CONNECTION
// ========================================

async function upstoxGet(path) {

  if (!TOKEN) {
    const e = new Error(
      "UPSTOX_ACCESS_TOKEN missing in Render."
    );
    e.status = 503;
    throw e;
  }

  const response = await fetch(
    `${UPSTOX_BASE}${path}`,
    {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${TOKEN}`
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const e = new Error(
      body?.errors?.[0]?.message ||
      body?.message ||
      `Upstox HTTP ${response.status}`
    );

    e.status = response.status;
    e.details = body;
    throw e;
  }

  return body;
}

// ========================================
// GET 5 MINUTE CANDLES
// ========================================

async function getIntradayCandles(instrumentKey) {

  const path =
    `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/5`;

  const json = await upstoxGet(path);

  return Array.isArray(json?.data?.candles)
    ? json.data.candles
    : [];
}

// ========================================
// INDIA TIME
// ========================================

function istParts(date) {

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  return Object.fromEntries(
    parts.map(p => [p.type, p.value])
  );
}

// ========================================
// CLOSED CANDLE FILTER
// ========================================

function isCompletedFiveMinuteCandle(
  candle,
  now = new Date()
) {

  const stamp = new Date(candle[0]).getTime();

  if (!Number.isFinite(stamp)) return false;

  return stamp + 300000 <= now.getTime();
}

function completedCandles(raw) {

  const now = new Date();

  return raw

    .filter(c =>
      Array.isArray(c) &&
      c.length >= 6 &&
      isCompletedFiveMinuteCandle(c, now)
    )

    .sort((a, b) =>
      new Date(a[0]).getTime() -
      new Date(b[0]).getTime()
    )

    .map(c => ({
      time: c[0],
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5] || 0),
      oi: Number(c[6] || 0)
    }))

    .filter(c =>
      [c.open, c.high, c.low, c.close]
        .every(Number.isFinite)
    );
}

// ========================================
// EMA 20
// ========================================

function ema(values, period) {

  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let value =
    values.slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {

    value =
      values[i] * k +
      value * (1 - k);
  }

  return value;
}

// ========================================
// RSI 14
// ========================================

function rsi(values, period = 14) {

  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {

    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) +
      Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) +
      Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return 100 -
    (100 / (1 + avgGain / avgLoss));
}

// ========================================
// AVERAGE
// ========================================

function average(values) {

  return values.length
    ? values.reduce((a, b) => a + b, 0) /
      values.length
    : 0;
}

// ========================================
// VWAP
// ========================================

function calcVwap(candles) {

  let pv = 0;
  let volume = 0;

  for (const c of candles) {

    const typical =
      (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    volume += c.volume;
  }

  return volume > 0
    ? pv / volume
    : null;
}

// ========================================
// ORB HIGH / LOW
// ========================================

function orbLevels(candles) {

  const opening = candles.filter(c => {

    const p = istParts(new Date(c.time));

    const mins =
      Number(p.hour) * 60 +
      Number(p.minute);

    return mins >= 555 && mins < 570;
  });

  if (opening.length < 3) {

    return {
      high: null,
      low: null,
      ready: false
    };
  }

  return {

    high: Math.max(
      ...opening.map(c => c.high)
    ),

    low: Math.min(
      ...opening.map(c => c.low)
    ),

    ready: true
  };
// ========================================
// SMART MONEY PRO ANALYSIS ENGINE
// ========================================

function analyseIndex(index, candles, futuresCandles = []) {

  if (candles.length < MIN_CANDLES) {
    return {
      symbol: index,
      name: INDEXES[index].label,
      status: "WAIT",
      signal: "INSUFFICIENT_DATA",
      message: "Need 21 completed candles",
      candlesAvailable: candles.length
    };
  }

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes, 14);
  const vwap = calcVwap(candles);

  const prior20 = candles.slice(-21, -1);

  const avgVol = average(
    prior20.map(c => c.volume)
  );

  const volumeRatio =
    avgVol > 0 ? last.volume / avgVol : 0;

  const resistance = Math.max(
    ...prior20.map(c => c.high)
  );

  const support = Math.min(
    ...prior20.map(c => c.low)
  );

  const orb = orbLevels(candles);

  // ======================================
  // BOS DETECTION
  // ======================================

  const bullishBOS =
    last.close > resistance &&
    prev.close <= resistance;

  const bearishBOS =
    last.close < support &&
    prev.close >= support;

  // ======================================
  // LIQUIDITY SWEEP
  // ======================================

  const liquiditySweepLow =
    last.low < support &&
    last.close > support;

  const liquiditySweepHigh =
    last.high > resistance &&
    last.close < resistance;

  // ======================================
  // ORB BREAKOUT
  // ======================================

  const orbBreakout =
    orb.ready && last.close > orb.high;

  const orbBreakdown =
    orb.ready && last.close < orb.low;

  // ======================================
  // FUTURES OI
  // ======================================

  const oiLast = futuresCandles.length
    ? futuresCandles[futuresCandles.length - 1].oi
    : 0;

  const oiPrev = futuresCandles.length > 1
    ? futuresCandles[futuresCandles.length - 2].oi
    : 0;

  const oiAvailable =
    oiLast > 0 && oiPrev > 0;

  const oiChangePct = oiAvailable
    ? ((oiLast - oiPrev) / oiPrev) * 100
    : null;

  const longBuildUp =
    oiAvailable &&
    oiChangePct > 0 &&
    last.close > prev.close;

  const shortBuildUp =
    oiAvailable &&
    oiChangePct > 0 &&
    last.close < prev.close;

  // ======================================
  // SMART MONEY CONDITIONS
  // ======================================

  const volumePass = volumeRatio >= 2.5;

  const bullishTrend =
    ema20 !== null &&
    vwap !== null &&
    last.close > ema20 &&
    last.close > vwap;

  const bearishTrend =
    ema20 !== null &&
    vwap !== null &&
    last.close < ema20 &&
    last.close < vwap;

  const bullishMomentum =
    rsi14 !== null && rsi14 >= 60;

  const bearishMomentum =
    rsi14 !== null && rsi14 <= 40;

  // ======================================
  // SIGNAL SCORING
  // ======================================

  const callScore = [
    bullishTrend,
    bullishMomentum,
    volumePass,
    bullishBOS || orbBreakout || liquiditySweepLow,
    longBuildUp
  ].filter(Boolean).length;

  const putScore = [
    bearishTrend,
    bearishMomentum,
    volumePass,
    bearishBOS || orbBreakdown || liquiditySweepHigh,
    shortBuildUp
  ].filter(Boolean).length;

  // ======================================
  // FINAL SIGNAL
  // ======================================

  let signal = "WAIT";
  let status = "WAIT";

  let reason = "Conditions not aligned";

  // If futures OI is unavailable,
  // require 3 technical confirmations.

  const requiredScore = oiAvailable ? 4 : 3;

  if (
    callScore >= requiredScore &&
    bullishTrend &&
    bullishMomentum &&
    volumePass
  ) {

    signal = "CALL_BIAS";
    status = "BULLISH";

    reason =
      "Bullish trend + RSI + volume + breakout confirmation";

  } else if (
    putScore >= requiredScore &&
    bearishTrend &&
    bearishMomentum &&
    volumePass
  ) {

    signal = "PUT_BIAS";
    status = "BEARISH";

    reason =
      "Bearish trend + RSI + volume + breakdown confirmation";
  }

  // ======================================
  // ENTRY / STOP LOSS / TARGET
  // ======================================

  const entry = last.close;

  const candleRange = Math.max(
    last.high - last.low,
    0
  );

  let stopLoss = null;
  let target1 = null;
  let target2 = null;

  if (status === "BULLISH") {

    stopLoss = Math.min(
      last.low,
      entry - candleRange * 1.2
    );

    const risk = entry - stopLoss;

    target1 = entry + risk * 1.5;
    target2 = entry + risk * 2;

  } else if (status === "BEARISH") {

    stopLoss = Math.max(
      last.high,
      entry + candleRange * 1.2
    );

    const risk = stopLoss - entry;

    target1 = entry - risk * 1.5;
    target2 = entry - risk * 2;
  }

  // ======================================
  // RESULT
  // ======================================

  return {

    symbol: index,

    name: INDEXES[index].label,

    exchange: INDEXES[index].exchange,

    status,

    signal,

    reason,

    timeframe: "5M CLOSED",

    candleTime: last.time,

    ltp: last.close,

    open: last.open,

    high: last.high,

    low: last.low,

    volume: last.volume,

    averageVolume20: Math.round(avgVol),

    volumeRatio: Number(
      volumeRatio.toFixed(2)
    ),

    rsi14: rsi14 === null
      ? null
      : Number(rsi14.toFixed(2)),

    ema20: ema20 === null
      ? null
      : Number(ema20.toFixed(2)),

    vwap: vwap === null
      ? null
      : Number(vwap.toFixed(2)),

    orbHigh: orb.high,

    orbLow: orb.low,

    orbReady: orb.ready,

    resistance20: resistance,

    support20: support,

    bullishBOS,

    bearishBOS,

    liquiditySweepLow,

    liquiditySweepHigh,

    oiAvailable,

    oiChangePct,

    oiNote: oiAvailable
      ? "Futures OI available"
      : "Futures OI not configured",

    score: `${status === "BULLISH"
      ? callScore
      : status === "BEARISH"
        ? putScore
        : Math.max(callScore, putScore)}/5`,

    entryReference: status === "WAIT"
      ? null
      : Number(entry.toFixed(2)),

    stopLossReference: stopLoss === null
      ? null
      : Number(stopLoss.toFixed(2)),

    target1Reference: target1 === null
      ? null
      : Number(target1.toFixed(2)),

    target2Reference: target2 === null
      ? null
      : Number(target2.toFixed(2)),

    warning:
      "Index directional signal only. Not an options contract recommendation."
  };
}

// ========================================
// SCAN SINGLE INDEX
// ========================================

async function scanOne(symbol) {

  const config = INDEXES[symbol];

  const [indexRaw, futuresRaw] = await Promise.all([

    getIntradayCandles(config.key),

    config.futuresKey
      ? getIntradayCandles(config.futuresKey)
          .catch(() => [])
      : Promise.resolve([])
  ]);

  const indexCandles =
    completedCandles(indexRaw);

  const futuresCandles =
    completedCandles(futuresRaw);

  return analyseIndex(
    symbol,
    indexCandles,
    futuresCandles
  );
}

// ========================================
// SCAN ALL FIVE INDEXES
// ========================================

async function runScan(force = false) {

  const cached = cache.get("scan");

  if (
    !force &&
    cached &&
    Date.now() - cached.time < CACHE_MS
  ) {
    return {
      ...cached.data,
      cached: true
    };
  }

  const results = await Promise.all(

    Object.keys(INDEXES).map(async symbol => {

      try {

        return await scanOne(symbol);

      } catch (error) {

        return {

          symbol,

          name: INDEXES[symbol].label,

          status: "ERROR",

          signal: "DATA_ERROR",

          message: error.message
        };
      }
    })
  );

  const data = {

    app: "SMART MONEY PRO INDEX SCANNER V1",

    timestamp: new Date().toISOString(),

    timeframe: "5-minute completed candles",

    indexes: results,

    summary: {

      bullish: results.filter(
        x => x.status === "BULLISH"
      ).length,

      bearish: results.filter(
        x => x.status === "BEARISH"
      ).length,

      wait: results.filter(
        x => x.status === "WAIT"
      ).length,

      errors: results.filter(
        x => x.status === "ERROR"
      ).length
    },

    notes: [

      "Completed 5-minute candles only.",

      "Futures OI requires configured futures instrument keys.",

      "Some index feeds may not provide volume.",

      "CALL_BIAS and PUT_BIAS are index direction signals.",

      "No automatic orders are placed."
    ],

    cached: false
  };

  cache.set("scan", {
    time: Date.now(),
    data
  });

  return data;
}

// ========================================
// HTTP SERVER
// ========================================

const server = http.createServer(
  async (req, res) => {

    if (req.method === "OPTIONS") {

      res.writeHead(204, {
        "Access-Control-Allow-Origin":
          process.env.CORS_ORIGIN || "*",

        "Access-Control-Allow-Methods":
          "GET,OPTIONS",

        "Access-Control-Allow-Headers":
          "Content-Type, Authorization"
      });

      return res.end();
    }

    const url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );

    try {

      // HEALTH CHECK

      if (url.pathname === "/health") {

        return send(res, 200, {

          ok: true,

          app: "SMART MONEY PRO INDEX SCANNER V1",

          node: process.version,

          tokenConfigured: Boolean(TOKEN),

          indexes: Object.keys(INDEXES)
        });
      }

      // MAIN SCANNER API

      if (url.pathname === "/api/pro-scanner") {

        const force =
          url.searchParams.get("refresh") === "1";

        const data = await runScan(force);

        return send(res, 200, data);
      }

      // CONFIGURATION CHECK

      if (url.pathname === "/api/pro-scanner/config") {

        return send(res, 200, {

          indexes: Object.entries(INDEXES).map(
            ([symbol, config]) => ({

              symbol,

              name: config.label,

              exchange: config.exchange,

              indexKeyConfigured: Boolean(config.key),

              futuresOiConfigured:
                Boolean(config.futuresKey)
            })
          ),

          timeframe: "5m",

          minCompletedCandles: MIN_CANDLES,

          cacheMs: CACHE_MS
        });
      }

      return send(res, 404, {

        error: "Route not found",

        routes: [

          "/health",

          "/api/pro-scanner",

          "/api/pro-scanner/config"
        ]
      });

    } catch (error) {

      return send(res, error.status || 500, {

        error: error.message,

        details: error.details || undefined
      });
    }
  }
);

// ========================================
// START SERVER
// ========================================

server.listen(PORT, "0.0.0.0", () => {

  console.log(
    `SMART MONEY PRO INDEX SCANNER running on port ${PORT}`
  );

  console.log(
    `Upstox token configured: ${Boolean(TOKEN)}`
  );
});
