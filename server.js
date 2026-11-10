// SMART MONEY PRO INDEX SCANNER V2
// NIFTY + BANKNIFTY + SENSEX + FINNIFTY + MIDCPNIFTY
// Node.js 20+ | UPSTOX V3

"use strict";

const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const API_BASE = "https://api.upstox.com";
const CACHE_MS = 30000;
const MIN_CANDLES = 21;

const INDEXES = {
  NIFTY: {
    name: "NIFTY 50",
    key: process.env.NIFTY_INDEX_KEY || "NSE_INDEX|Nifty 50",
    futuresKey: process.env.NIFTY_FUTURES_KEY || ""
  },
  BANKNIFTY: {
    name: "BANK NIFTY",
    key: process.env.BANKNIFTY_INDEX_KEY || "NSE_INDEX|Nifty Bank",
    futuresKey: process.env.BANKNIFTY_FUTURES_KEY || ""
  },
  SENSEX: {
    name: "SENSEX",
    key: process.env.SENSEX_INDEX_KEY || "BSE_INDEX|SENSEX",
    futuresKey: process.env.SENSEX_FUTURES_KEY || ""
  },
  FINNIFTY: {
    name: "FINNIFTY",
    key: process.env.FINNIFTY_INDEX_KEY || "NSE_INDEX|Nifty Fin Service",
    futuresKey: process.env.FINNIFTY_FUTURES_KEY || ""
  },
  MIDCPNIFTY: {
    name: "MIDCAP NIFTY",
    key: process.env.MIDCPNIFTY_INDEX_KEY || "NSE_INDEX|Nifty Midcap Select",
    futuresKey: process.env.MIDCPNIFTY_FUTURES_KEY || ""
  }
};

const cache = new Map();

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

async function upstoxGet(path) {
  if (!TOKEN) {
    const err = new Error(
      "UPSTOX_ACCESS_TOKEN is missing"
    );
    err.status = 503;
    throw err;
  }

  const response = await fetch(
    `${API_BASE}${path}`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${TOKEN}`
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const err = new Error(
      body?.errors?.[0]?.message ||
      body?.message ||
      `Upstox HTTP ${response.status}`
    );

    err.status = response.status;
    err.details = body;
    throw err;
  }

  return body;
}

async function getCandles(instrumentKey) {
  const path =
    `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/minutes/5`;

  const json = await upstoxGet(path);

  return Array.isArray(json?.data?.candles)
    ? json.data.candles
    : [];
}

function completedCandles(rows) {
  const now = Date.now();

  return rows
    .filter(row => {
      const start = new Date(row[0]).getTime();

      return Array.isArray(row) &&
        row.length >= 6 &&
        Number.isFinite(start) &&
        start + 300000 <= now;
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
      [c.open, c.high, c.low, c.close]
        .every(Number.isFinite)
    )
    .sort((a, b) =>
      new Date(a.time) - new Date(b.time)
    );
}

function average(values) {
  return values.length
    ? values.reduce((sum, n) => sum + n, 0) /
      values.length
    : 0;
}

function ema(values, period) {
  if (values.length < period) return null;

  const k = 2 / (period + 1);

  let result = average(values.slice(0, period));

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * k +
      result * (1 - k);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];

    if (d > 0) gain += d;
    else loss -= d;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) +
      Math.max(d, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) +
      Math.max(-d, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

function vwap(candles) {
  let pv = 0;
  let vol = 0;

  for (const c of candles) {
    const typical =
      (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    vol += c.volume;
  }

  return vol > 0 ? pv / vol : null;
}

function istMinutes(isoTime) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(isoTime));

  const p = Object.fromEntries(
    parts.map(x => [x.type, x.value])
  );

  return Number(p.hour) * 60 + Number(p.minute);
}

function openingRange(candles) {
  const firstBars = candles.filter(c => {
    const m = istMinutes(c.time);
    return m >= 555 && m < 570;
  });

  if (firstBars.length < 3) {
    return {
      ready: false,
      high: null,
      low: null
    };
  }

  return {
    ready: true,
    high: Math.max(...firstBars.map(c => c.high)),
    low: Math.min(...firstBars.map(c => c.low))
  };
  }// ========================================
// SMART MONEY ANALYSIS ENGINE
// ========================================

function analyseIndex(symbol, candles, futures = []) {

  const config = INDEXES[symbol];

  if (candles.length < MIN_CANDLES) {
    return {
      symbol,
      name: config.name,
      status: "WAIT",
      signal: "INSUFFICIENT_DATA",
      candlesAvailable: candles.length,
      message: "Waiting for 21 completed candles"
    };
  }

  const closes = candles.map(c => c.close);

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const ema20 = ema(closes, 20);
  const rsi14 = rsi(closes, 14);
  const currentVwap = vwap(candles);

  const previous20 = candles.slice(-21, -1);

  const averageVolume = average(
    previous20.map(c => c.volume)
  );

  const volumeRatio = averageVolume > 0
    ? last.volume / averageVolume
    : 0;

  const resistance = Math.max(
    ...previous20.map(c => c.high)
  );

  const support = Math.min(
    ...previous20.map(c => c.low)
  );

  const orb = openingRange(candles);

  const bullishBOS =
    last.close > resistance &&
    prev.close <= resistance;

  const bearishBOS =
    last.close < support &&
    prev.close >= support;

  const liquiditySweepLow =
    last.low < support &&
    last.close > support;

  const liquiditySweepHigh =
    last.high > resistance &&
    last.close < resistance;

  const orbBreakout =
    orb.ready && last.close > orb.high;

  const orbBreakdown =
    orb.ready && last.close < orb.low;

  // Futures OI confirmation
  const oiLast = futures.length
    ? futures[futures.length - 1].oi
    : 0;

  const oiPrev = futures.length > 1
    ? futures[futures.length - 2].oi
    : 0;

  const oiAvailable = oiLast > 0 && oiPrev > 0;

  const oiChange = oiAvailable
    ? ((oiLast - oiPrev) / oiPrev) * 100
    : null;

  const longBuildUp =
    oiAvailable &&
    oiChange > 0 &&
    last.close > prev.close;

  const shortBuildUp =
    oiAvailable &&
    oiChange > 0 &&
    last.close < prev.close;

  // Trend filters
  const volumePass = volumeRatio >= 2.5;

  const bullishTrend =
    ema20 !== null &&
    currentVwap !== null &&
    last.close > ema20 &&
    last.close > currentVwap;

  const bearishTrend =
    ema20 !== null &&
    currentVwap !== null &&
    last.close < ema20 &&
    last.close < currentVwap;

  const bullishRSI =
    rsi14 !== null && rsi14 >= 60;

  const bearishRSI =
    rsi14 !== null && rsi14 <= 40;

  // Signal scoring
  const callScore = [
    bullishTrend,
    bullishRSI,
    volumePass,
    bullishBOS || orbBreakout || liquiditySweepLow,
    longBuildUp
  ].filter(Boolean).length;

  const putScore = [
    bearishTrend,
    bearishRSI,
    volumePass,
    bearishBOS || orbBreakdown || liquiditySweepHigh,
    shortBuildUp
  ].filter(Boolean).length;

  let status = "WAIT";
  let signal = "WAIT";
  let reason = "Conditions not aligned";

  const requiredScore = oiAvailable ? 4 : 3;

  if (
    callScore >= requiredScore &&
    bullishTrend &&
    bullishRSI &&
    volumePass
  ) {
    status = "BULLISH";
    signal = "CALL_BIAS";
    reason = "Bullish momentum and breakout confirmation";
  } else if (
    putScore >= requiredScore &&
    bearishTrend &&
    bearishRSI &&
    volumePass
  ) {
    status = "BEARISH";
    signal = "PUT_BIAS";
    reason = "Bearish momentum and breakdown confirmation";
  }

  // Risk references
  const entry = last.close;
  const candleRange = last.high - last.low;

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
  }

  if (status === "BEARISH") {
    stopLoss = Math.max(
      last.high,
      entry + candleRange * 1.2
    );

    const risk = stopLoss - entry;

    target1 = entry - risk * 1.5;
    target2 = entry - risk * 2;
  }

  return {
    symbol,
    name: config.name,
    status,
    signal,
    reason,
    timeframe: "5M CLOSED",
    candleTime: last.time,
    ltp: last.close,
    volume: last.volume,
    averageVolume20: Math.round(averageVolume),
    volumeRatio: Number(volumeRatio.toFixed(2)),
    rsi14: Number(rsi14.toFixed(2)),
    ema20: Number(ema20.toFixed(2)),
    vwap: currentVwap === null
      ? null
      : Number(currentVwap.toFixed(2)),
    orbHigh: orb.high,
    orbLow: orb.low,
    orbReady: orb.ready,
    bullishBOS,
    bearishBOS,
    liquiditySweepLow,
    liquiditySweepHigh,
    oiAvailable,
    oiChangePct: oiChange,
    oiNote: oiAvailable
      ? "Futures OI available"
      : "Futures OI not configured",
    score: `${status === "BULLISH"
      ? callScore
      : status === "BEARISH"
        ? putScore
        : Math.max(callScore, putScore)}/5`,
    entryReference: status === "WAIT" ? null : entry,
    stopLossReference: stopLoss,
    target1Reference: target1,
    target2Reference: target2,
    warning: "Directional index signal only. Not a trade guarantee."
  };
}

// ========================================
// SCAN ONE INDEX
// ========================================

async function scanOne(symbol) {

  const config = INDEXES[symbol];

  const [indexRows, futuresRows] = await Promise.all([
    getCandles(config.key),

    config.futuresKey
      ? getCandles(config.futuresKey).catch(() => [])
      : Promise.resolve([])
  ]);

  return analyseIndex(
    symbol,
    completedCandles(indexRows),
    completedCandles(futuresRows)
  );
}

// ========================================
// SCAN ALL INDEXES
// ========================================

async function runScan(force = false) {

  const old = cache.get("scan");

  if (
    !force &&
    old &&
    Date.now() - old.time < CACHE_MS
  ) {
    return {
      ...old.data,
      cached: true
    };
  }

  const indexes = await Promise.all(
    Object.keys(INDEXES).map(async symbol => {

      try {
        return await scanOne(symbol);

      } catch (error) {
        return {
          symbol,
          name: INDEXES[symbol].name,
          status: "ERROR",
          signal: "DATA_ERROR",
          message: error.message
        };
      }
    })
  );

  const data = {
    app: "SMART MONEY PRO INDEX SCANNER V2",
    timestamp: new Date().toISOString(),
    timeframe: "5-minute completed candles",
    indexes,

    summary: {
      bullish: indexes.filter(
        x => x.status === "BULLISH"
      ).length,

      bearish: indexes.filter(
        x => x.status === "BEARISH"
      ).length,

      wait: indexes.filter(
        x => x.status === "WAIT"
      ).length,

      errors: indexes.filter(
        x => x.status === "ERROR"
      ).length
    },

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

const server = http.createServer(async (req, res) => {

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  try {

    if (url.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        app: "SMART MONEY PRO INDEX SCANNER V2",
        node: process.version,
        tokenConfigured: Boolean(TOKEN),
        indexes: Object.keys(INDEXES)
      });
    }

    if (url.pathname === "/api/pro-scanner") {

      const force =
        url.searchParams.get("refresh") === "1";

      return send(res, 200, await runScan(force));
    }

    if (url.pathname === "/api/pro-scanner/config") {

      return send(res, 200, {
        timeframe: "5m",
        indexes: Object.keys(INDEXES),
        minCompletedCandles: MIN_CANDLES
      });
    }

    return send(res, 404, {
      error: "Route not found"
    });

  } catch (error) {

    return send(res, error.status || 500, {
      error: error.message,
      details: error.details || undefined
    });
  }
});

// ========================================
// START SERVER
// ========================================

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    "SMART MONEY PRO INDEX SCANNER V2 running on port " + PORT
  );

  console.log(
    "Upstox token configured: " + Boolean(TOKEN)
  );
});
