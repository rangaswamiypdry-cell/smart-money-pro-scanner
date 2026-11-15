
'use strict';

// SMART MONEY PRO V4 - FOUR INDEX CE/PE
// Node.js 20+ | Upstox | Signal History | SL/TP Tracking

const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || '';
const API = 'https://api.upstox.com';
const MASTER_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE = path.join(DATA_DIR, 'smart-money-pro-v4-store.json');

const INDEXES = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY'];

const CONFIG = {
  VERSION: 'SMART_MONEY_PRO_V4_DATABASE_TRADE_TRACKING',
  TIMEFRAME_MINUTES: 5,
  SCAN_INTERVAL_MS: 15000,
  CACHE_MS: 5000,
  RSI_PERIOD: 14,
  RSI_BUY_MIN: 65,
  RSI_SELL_MAX: 35,
  VOLUME_MULTIPLIER: 1.5,
  MIN_FUTURES_OI_CHANGE_PERCENT: 0.10,
  MIN_OPTION_OI_CHANGE_PERCENT: 0.01,
  MIN_OPTION_VOLUME_CHANGE: 1,
  MAX_SPREAD_PERCENT: 2,
  MIN_DELTA: 0.40,
  MAX_DELTA: 0.70,
  MAX_STRIKES_EACH_SIDE: 30,
  MARKET_START: '09:15',
  CONFIRM_AFTER: '09:30',
  MARKET_END: '15:30',
  STOP_LOSS_PERCENT: 25,
  TARGET1_PERCENT: 30,
  TARGET2_PERCENT: 50,
  HISTORY_DAYS: 5,
  MAX_HISTORY_RECORDS: 5000,
  QUOTE_CHECK_MS: 15000
};

let instrumentMaster = [];
let indexMap = [];
let masterLoaded = false;
let scanRunning = false;
let lastScan = null;
let lastScanAt = 0;

const optionSnapshots = new Map();
const activeSignals = new Map();
const signalHistory = [];
const seenSignalKeys = new Set();

let nextSignalId = 1;
let persistenceReady = false;
let lastQuoteCheckAt = 0;
let lastAlertEventId = 0;

// =====================================
// PERSISTENT SIGNAL STORE
// =====================================

function ensureDataDirectory() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function persistStore() {
  ensureDataDirectory();

  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    nextSignalId,
    lastAlertEventId,
    history: signalHistory.slice(-CONFIG.MAX_HISTORY_RECORDS),
    active: [...activeSignals.entries()],
    seenKeys: [...seenSignalKeys].slice(-CONFIG.MAX_HISTORY_RECORDS)
  };

  const temp = `${DB_FILE}.tmp`;

  fs.writeFileSync(temp, JSON.stringify(payload, null, 2));
  fs.renameSync(temp, DB_FILE);
}

function loadStore() {
  if (persistenceReady) return;

  ensureDataDirectory();

  try {
    if (fs.existsSync(DB_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

      if (Array.isArray(saved.history)) {
        signalHistory.push(...saved.history);
      }

      if (Array.isArray(saved.active)) {
        for (const [key, value] of saved.active) {
          activeSignals.set(key, value);
        }
      }

      if (Array.isArray(saved.seenKeys)) {
        for (const key of saved.seenKeys) {
          seenSignalKeys.add(key);
        }
      }

      nextSignalId = Number(saved.nextSignalId || 1);
      lastAlertEventId = Number(saved.lastAlertEventId || 0);

      console.log('[STORE LOADED]', {
        history: signalHistory.length,
        active: activeSignals.size
      });
    }
  } catch (error) {
    console.error('[STORE LOAD ERROR]', error.message);
  }

  persistenceReady = true;
}

function makeSignalKey(symbol, side, option) {
  return [
    symbol,
    side,
    option.strikePrice,
    option.expiry
  ].join('|');
}

function istStamp(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true
  }).format(date);
}

function expiryCountdown(expiry) {
  if (!expiry) return null;

  const expiryMs =
    new Date(`${expiry}T15:30:00+05:30`).getTime();

  const seconds = Math.max(
    0,
    Math.floor((expiryMs - Date.now()) / 1000)
  );

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return {
    seconds,
    days,
    hours,
    minutes,
    label: `${days}d ${hours}h ${minutes}m`
  };
}

function appendSignalEvent(signal, eventType, details = {}) {
  const event = {
    eventId: ++lastAlertEventId,
    signalId: signal.id,
    symbol: signal.symbol,
    eventType,
    message:
      `${signal.symbol} ${signal.option?.signal || signal.signal}: ${eventType}`,
    createdAt: new Date().toISOString(),
    ...details
  };

  signal.events = Array.isArray(signal.events)
    ? signal.events
    : [];

  signal.events.push(event);
  signal.lastEventId = event.eventId;

  persistStore();

  return event;
}

function addSignalToHistory(result) {
  loadStore();

  const option = result.option;

  const key = makeSignalKey(
    result.symbol,
    result.optionSide,
    option
  );

  if (seenSignalKeys.has(key)) {
    const existing = signalHistory.find(
      x => x.dedupeKey === key
    );

    return existing || null;
  }

  seenSignalKeys.add(key);

  const entry = {
    ...result,

    id: nextSignalId++,
    dedupeKey: key,

    signalTimestamp: new Date().toISOString(),
    signalTimeIST: istStamp(),

    expiryCountdown: expiryCountdown(option.expiry),

    tradeStatus: 'ACTIVE',

    target1Hit: false,
    target2Hit: false,
    stopLossHit: false,

    executionStatus: 'NOT_PLACED',
    executionUpdatedAt: null,

    currentOptionPrice: option.premium,

    events: [],
    lastEventId: 0
  };

  signalHistory.push(entry);

  if (signalHistory.length > CONFIG.MAX_HISTORY_RECORDS) {
    signalHistory.splice(
      0,
      signalHistory.length - CONFIG.MAX_HISTORY_RECORDS
    );
  }

  appendSignalEvent(entry, 'NEW_SIGNAL');

  return entry;
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;

      if (raw.length > 100000) {
        reject(new Error('BODY_TOO_LARGE'));
      }
    });

    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });

    req.on('error', reject);
  });
}

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const round = value =>
  Number.isFinite(Number(value))
    ? Number(Number(value).toFixed(2))
    : null;

// =====================================
// IST TIME
// =====================================

function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);

  return Object.fromEntries(
    parts.map(p => [p.type, p.value])
  );
}

function istDate(date = new Date()) {
  const p = istParts(date);

  return `${p.year}-${p.month}-${p.day}`;
}

function istTime(date = new Date()) {
  const p = istParts(date);

  return `${p.hour}:${p.minute}`;
}

function marketIsOpenTime() {
  const t = istTime();

  return (
    t >= CONFIG.MARKET_START &&
    t <= CONFIG.MARKET_END
  );
}

function afterConfirmationTime() {
  return istTime() >= CONFIG.CONFIRM_AFTER;
}

function istDateDaysAgo(days) {
  const p = istParts();

  const d = new Date(
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day) - days
    )
  );

  return d.toISOString().slice(0, 10);
}

// =====================================
// HTTP JSON
// =====================================

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(data));
}

// =====================================
// UPSTOX API
// =====================================

async function upstoxGET(path) {
  if (!TOKEN) {
    throw new Error('UPSTOX_ACCESS_TOKEN_MISSING');
  }

  const response = await fetch(API + path, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${TOKEN}`
    },
    signal: AbortSignal.timeout(25000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.errors?.[0]?.message ||
      data?.message ||
      `UPSTOX_HTTP_${response.status}`
    );
  }

  return data;
}

// =====================================
// INSTRUMENT MASTER
// =====================================

async function downloadInstrumentMaster() {
  const response = await fetch(MASTER_URL, {
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    throw new Error(`MASTER_DOWNLOAD_FAILED_${response.status}`);
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  let rows;

  try {
    rows = JSON.parse(
      zlib.gunzipSync(buffer).toString('utf8')
    );
  } catch {
    rows = JSON.parse(buffer.toString('utf8'));
  }

  if (!Array.isArray(rows)) {
    throw new Error('INVALID_MASTER_DATA');
  }

  return rows;
}

function normalizeExpiry(value) {
  if (!value) return '';

  const n = Number(value);

  if (Number.isFinite(n) && n > 0) {
    return new Date(
      n < 1e12 ? n * 1000 : n
    ).toISOString().slice(0, 10);
  }

  const d = new Date(value);

  return Number.isNaN(d.getTime())
    ? ''
    : d.toISOString().slice(0, 10);
}

function norm(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

async function loadIndexMaster() {
  if (masterLoaded && indexMap.length === 4) return;

  instrumentMaster = await downloadInstrumentMaster();

  const aliases = {
    NIFTY: ['NIFTY 50', 'NIFTY'],
    BANKNIFTY: ['NIFTY BANK', 'BANKNIFTY'],
    SENSEX: ['SENSEX'],
    FINNIFTY: [
      'NIFTY FIN SERVICE',
      'NIFTY FINANCIAL SERVICES',
      'FINNIFTY'
    ]
  };

  const today = istDate();

  indexMap = [];

  for (const symbol of INDEXES) {
    const names = aliases[symbol];

    const segment =
      symbol === 'SENSEX'
        ? 'BSE_INDEX'
        : 'NSE_INDEX';

    const foSegment =
      symbol === 'SENSEX'
        ? 'BSE_FO'
        : 'NSE_FO';

    const matches = value =>
      names.some(n => norm(n) === norm(value));

    const indexInstrument = instrumentMaster.find(
      item =>
        item.segment === segment &&
        item.instrument_type === 'INDEX' &&
        (
          matches(item.name) ||
          matches(item.trading_symbol)
        )
    );

    const futures = instrumentMaster
      .filter(item =>
        item.segment === foSegment &&
        item.instrument_type === 'FUT' &&
        item.instrument_key &&
        (
          matches(item.underlying_symbol) ||
          matches(item.name) ||
          matches(item.trading_symbol)
        ) &&
        normalizeExpiry(item.expiry) >= today
      )
      .sort((a, b) =>
        normalizeExpiry(a.expiry).localeCompare(
          normalizeExpiry(b.expiry)
        )
      );

    const future = futures[0];

    if (!indexInstrument || !future) {
      console.log('[INDEX NOT MAPPED]', symbol, {
        indexFound: !!indexInstrument,
        futuresFound: futures.length
      });

      continue;
    }

    indexMap.push({
      symbol,
      indexKey: indexInstrument.instrument_key,
      futuresKey: future.instrument_key,
      futuresSymbol: future.trading_symbol,
      expiry: normalizeExpiry(future.expiry),
      lotSize: Number(future.lot_size || 0)
    });

    console.log(
      '[INDEX MAPPED]',
      symbol,
      indexInstrument.instrument_key,
      future.instrument_key
    );
  }

  masterLoaded = indexMap.length === 4;

  console.log('[MASTER RESULT]', {
    mapped: indexMap.length,
    expected: 4
  });
}

// =====================================
// 5 MINUTE CANDLES
// =====================================

function mapCandle(c) {
  const time = new Date(c[0]).getTime();

  return {
    time,
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5] || 0),
    oi: Number(c[6] || 0)
  };
}

function isCompleted(c) {
  return (
    Number.isFinite(c.time) &&
    c.close > 0 &&
    c.time + 300000 <= Date.now()
  );
}

async function getIndexCandles(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const today = istDate();
  const from = istDateDaysAgo(CONFIG.HISTORY_DAYS);

  const [historical, intraday] = await Promise.all([
    upstoxGET(
      `/v3/historical-candle/${key}/minutes/5/${today}/${from}`
    ).catch(async () =>
      upstoxGET(
        `/v3/historical-candle/${key}/minutes/5/${today}`
      )
    ),

    upstoxGET(
      `/v3/historical-candle/intraday/${key}/minutes/5`
    )
  ]);

  const all = [
    ...(historical?.data?.candles || []),
    ...(intraday?.data?.candles || [])
  ]
    .map(mapCandle)
    .filter(isCompleted)
    .sort((a, b) => a.time - b.time);

  const unique = new Map(
    all.map(c => [c.time, c])
  );

  return [...unique.values()].sort(
    (a, b) => a.time - b.time
  );
}

// =====================================
// RSI
// =====================================

function calculateRSI(closes, period = 14) {
  if (closes.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change > 0) gain += change;
    else loss -= change;
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];

    avgGain =
      (avgGain * (period - 1) +
        Math.max(change, 0)) / period;

    avgLoss =
      (avgLoss * (period - 1) +
        Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return 100;

  return round(
    100 - 100 / (1 + avgGain / avgLoss)
  );
}

// =====================================
// VOLUME
// =====================================

function calculateVolumeRatio(candles) {
  if (candles.length < 22) return 0;

  const previous = candles.slice(-21, -1);

  const average = previous.reduce(
    (sum, c) => sum + c.volume,
    0
  ) / previous.length;

  return average > 0
    ? round(candles[candles.length - 1].volume / average)
    : 0;
}

// =====================================
// VWAP
// =====================================

function calculateSessionVWAP(candles) {
  let pv = 0;
  let volume = 0;

  for (const c of candles) {
    const typical =
      (c.high + c.low + c.close) / 3;

    pv += typical * c.volume;
    volume += c.volume;
  }

  return volume > 0 ? pv / volume : null;
}

// =====================================
// CANDLE STRENGTH
// =====================================

function strongBearish(c) {
  const range = c.high - c.low;

  if (range <= 0) return false;

  return (
    c.close < c.open &&
    (c.open - c.close) / range >= 0.5
  );
}

function strongBullish(c) {
  const range = c.high - c.low;

  if (range <= 0) return false;

  return (
    c.close > c.open &&
    (c.close - c.open) / range >= 0.5
  );
}

// =====================================
// INDEX ANALYSIS
// =====================================

function analyseIndex(index, candles) {
  const today = candles.filter(
    c => istDate(new Date(c.time)) === istDate()
  );

  if (candles.length < 22 || today.length < 3) {
    return {
      symbol: index.symbol,
      signal: 'WAIT',
      reason: 'NEED_22_TOTAL_AND_3_COMPLETED_TODAY_CANDLES',
      completedToday: today.length,
      totalCandles: candles.length
    };
  }

  const last = today[today.length - 1];
  const previous = today[today.length - 2];

  const rsi = calculateRSI(
    candles.map(c => c.close),
    CONFIG.RSI_PERIOD
  );

  const volumeRatio = calculateVolumeRatio(candles);

  const oiChange = previous.oi > 0
    ? ((last.oi - previous.oi) / previous.oi) * 100
    : null;

  const oiIncreasing =
    oiChange !== null &&
    oiChange >= CONFIG.MIN_FUTURES_OI_CHANGE_PERCENT;

  const vwap = calculateSessionVWAP(today);

  const priceDown = last.close < previous.close;
  const priceUp = last.close > previous.close;

  const belowVWAP =
    vwap !== null && last.close < vwap;

  const aboveVWAP =
    vwap !== null && last.close > vwap;

  const volumePass =
    volumeRatio >= CONFIG.VOLUME_MULTIPLIER;

  const bearCandle = strongBearish(last);
  const bullCandle = strongBullish(last);

  const bearConditions = {
    priceDirection: priceDown,
    futuresOIIncreasing: oiIncreasing,
    volumeSpike: volumePass,
    rsiWeak: rsi !== null && rsi <= CONFIG.RSI_SELL_MAX,
    belowVWAP,
    strongBearishCandle: bearCandle
  };

  const bullConditions = {
    priceDirection: priceUp,
    futuresOIIncreasing: oiIncreasing,
    volumeSpike: volumePass,
    rsiStrong: rsi !== null && rsi >= CONFIG.RSI_BUY_MIN,
    aboveVWAP,
    strongBullishCandle: bullCandle
  };

  const bearScore = Object.values(bearConditions)
    .filter(Boolean).length;

  const bullScore = Object.values(bullConditions)
    .filter(Boolean).length;

  const side =
    bearScore === 6 ? 'CE' :
    bullScore === 6 ? 'PE' :
    null;

  return {
    symbol: index.symbol,
    signal: side
      ? (side === 'CE' ? 'CE_SELL' : 'PE_SELL')
      : 'WAIT',

    optionSide: side,

    price: round(last.close),
    rsi,
    volumeRatio,
    futuresOIChangePercent: round(oiChange),
    currentOI: last.oi,
    previousOI: previous.oi,
    vwap: round(vwap),

    candleTime: istTime(new Date(last.time)),
    timeframe: '5 MINUTES',

    bearishStrength: `${bearScore}/6`,
    bullishStrength: `${bullScore}/6`,

    conditions:
      side === 'CE' ? bearConditions :
      side === 'PE' ? bullConditions :
      {
        bearish: bearConditions,
        bullish: bullConditions
      },

    futuresInstrumentKey: index.futuresKey,
    indexInstrumentKey: index.indexKey,
    futuresSymbol: index.futuresSymbol,
    expiry: index.expiry
  };
      }

// =====================================
// OPTION CHAIN
// =====================================

async function getOptionChain(indexKey) {
  const key = encodeURIComponent(indexKey);

  const contracts = await upstoxGET(
    `/v2/option/contract?instrument_key=${key}`
  );

  const rows = contracts?.data || [];

  const expiries = [...new Set(
    rows
      .map(x => normalizeExpiry(x.expiry))
      .filter(x => x >= istDate())
  )].sort();

  if (!expiries.length) {
    throw new Error('NO_OPTION_EXPIRY');
  }

  const expiry = expiries[0];

  const chain = await upstoxGET(
    `/v2/option/chain?instrument_key=${key}&expiry_date=${expiry}`
  );

  return {
    expiry,
    chain: chain?.data || []
  };
}

function getSideOption(row, side) {
  return side === 'CE'
    ? row.call_options
    : row.put_options;
}

// =====================================
// OPTION SELL ANALYSIS
// =====================================

function analyseOption(row, side, expiry) {
  const option = getSideOption(row, side);

  if (!option?.instrument_key) return null;

  const market = option.market_data || {};
  const greeks = option.option_greeks || {};

  const ltp = Number(market.ltp || 0);
  const bid = Number(market.bid_price || 0);
  const ask = Number(market.ask_price || 0);
  const volume = Number(market.volume || 0);
  const oi = Number(market.oi || 0);

  const delta = Math.abs(Number(greeks.delta || 0));

  if (
    ltp <= 0 ||
    bid <= 0 ||
    ask <= 0 ||
    volume <= 0 ||
    oi <= 0 ||
    ask < bid ||
    delta < CONFIG.MIN_DELTA ||
    delta > CONFIG.MAX_DELTA
  ) return null;

  const spreadPercent = ((ask - bid) / ltp) * 100;

  if (spreadPercent > CONFIG.MAX_SPREAD_PERCENT) {
    return null;
  }

  const instrumentKey = option.instrument_key;
  const previous = optionSnapshots.get(instrumentKey);

  optionSnapshots.set(instrumentKey, {
    ltp,
    volume,
    oi,
    time: Date.now()
  });

  if (!previous || previous.oi <= 0) return null;

  const premiumFalling = ltp < previous.ltp;

  const volumeIncreasing =
    volume >= previous.volume + CONFIG.MIN_OPTION_VOLUME_CHANGE;

  const oiIncreasing =
    oi > previous.oi &&
    ((oi - previous.oi) / previous.oi) * 100 >=
      CONFIG.MIN_OPTION_OI_CHANGE_PERCENT;

  const conditions = {
    premiumFalling,
    optionVolumeIncreasing: volumeIncreasing,
    optionOIIncreasing: oiIncreasing
  };

  if (!Object.values(conditions).every(Boolean)) {
    return null;
  }

  return {
    optionType: side,
    strikePrice: Number(row.strike_price),
    instrumentKey,
    expiry,

    premium: round(ltp),
    entry: round(bid),
    bid: round(bid),
    ask: round(ask),

    volume,
    previousVolume: previous.volume,

    oi,
    previousOI: previous.oi,

    optionOIChangePercent: round(
      ((oi - previous.oi) / previous.oi) * 100
    ),

    delta: round(greeks.delta),
    spreadPercent: round(spreadPercent),
    conditions
  };
}

function optionScore(o) {
  return (
    Math.log10(1 + o.volume) *
    (1 + Math.max(0, o.optionOIChangePercent))
  ) / (
    (1 + o.spreadPercent) *
    (1 + Math.abs(Math.abs(o.delta) - 0.5) * 5)
  );
}

// =====================================
// AUTOMATIC CE / PE STRIKE SELECTION
// =====================================

async function selectStrongSellOption(index, analysis) {
  const side = analysis.optionSide;

  const data = await getOptionChain(index.indexKey);

  const candidates = [];

  for (const row of data.chain) {
    const candidate = analyseOption(
      row,
      side,
      data.expiry
    );

    if (candidate) {
      candidates.push(candidate);
    }
  }

  candidates.sort(
    (a, b) => optionScore(b) - optionScore(a)
  );

  if (!candidates.length) {
    return {
      success: false,
      reason: `WAITING_FOR_${side}_PREMIUM_DOWN_OI_UP_VOLUME_UP`
    };
  }

  const best = candidates[0];
  const entry = best.entry;

  return {
    success: true,

    signal: `${side}_SELL`,
    optionType: side,

    strikePrice: best.strikePrice,
    instrumentKey: best.instrumentKey,
    expiry: best.expiry,

    premium: best.premium,
    entry,

    stopLoss: round(
      entry * (1 + CONFIG.STOP_LOSS_PERCENT / 100)
    ),

    target1: round(
      entry * (1 - CONFIG.TARGET1_PERCENT / 100)
    ),

    target2: round(
      entry * (1 - CONFIG.TARGET2_PERCENT / 100)
    ),

    volume: best.volume,
    previousVolume: best.previousVolume,

    oi: best.oi,
    previousOI: best.previousOI,

    optionOIChangePercent: best.optionOIChangePercent,

    delta: best.delta,
    spreadPercent: best.spreadPercent,

    optionConditions: best.conditions,
    selectionScore: round(optionScore(best)),

    note: `${side} SELL candidate - verify live bid/ask, liquidity and risk before any trade`
  };
}

// =====================================
// LIVE OPTION QUOTE
// =====================================

async function getOptionLiveQuote(instrumentKey) {
  const key = encodeURIComponent(instrumentKey);

  const data = await upstoxGET(
    `/v2/market-quote/quotes?instrument_key=${key}`
  );

  const values = data?.data || {};

  const quote =
    values[instrumentKey] ||
    values[Object.keys(values)[0]] ||
    {};

  const ltp = Number(
    quote.last_price ||
    quote.ltp ||
    quote.market_data?.ltp ||
    0
  );

  return { ltp, quote };
}

// =====================================
// ENTRY / SL / TARGET STATUS TRACKER
// =====================================

async function updateTradeStatuses() {
  loadStore();

  const now = Date.now();

  if (now - lastQuoteCheckAt < CONFIG.QUOTE_CHECK_MS) {
    return;
  }

  lastQuoteCheckAt = now;

  const openTrades = signalHistory.filter(
    x =>
      x.tradeStatus === 'ACTIVE' ||
      x.tradeStatus === 'TARGET1_HIT'
  );

  for (const signal of openTrades) {
    try {
      const countdown = expiryCountdown(signal.option.expiry);

      if (countdown && countdown.seconds <= 0) {
        signal.tradeStatus = 'EXPIRED';
        signal.closedAt = new Date().toISOString();

        appendSignalEvent(signal, 'EXPIRY_REACHED');

        continue;
      }

      const quote = await getOptionLiveQuote(
        signal.option.instrumentKey
      );

      if (!(quote.ltp > 0)) continue;

      const previousPrice = signal.currentOptionPrice;

      signal.currentOptionPrice = round(quote.ltp);
      signal.lastPriceUpdatedAt = new Date().toISOString();
      signal.expiryCountdown = countdown;

      // SELL position: premium rises = loss.
      // SELL position: premium falls = profit.

      if (
        !signal.stopLossHit &&
        quote.ltp >= Number(signal.option.stopLoss)
      ) {
        signal.stopLossHit = true;

        signal.tradeStatus = signal.target1Hit
          ? 'STOP_LOSS_HIT_AFTER_T1'
          : 'STOP_LOSS_HIT';

        signal.closedAt = new Date().toISOString();

        appendSignalEvent(
          signal,
          'STOP_LOSS_HIT',
          {
            price: round(quote.ltp),
            previousPrice
          }
        );
      } else {
        if (
          !signal.target1Hit &&
          quote.ltp <= Number(signal.option.target1)
        ) {
          signal.target1Hit = true;
          signal.target1HitAt = new Date().toISOString();

          signal.tradeStatus = 'TARGET1_HIT';

          appendSignalEvent(
            signal,
            'TARGET1_HIT',
            {
              price: round(quote.ltp),
              previousPrice
            }
          );
        }

        if (
          !signal.target2Hit &&
          quote.ltp <= Number(signal.option.target2)
        ) {
          signal.target2Hit = true;
          signal.tradeStatus = 'TARGET2_HIT';

          signal.target2HitAt = new Date().toISOString();
          signal.closedAt = new Date().toISOString();

          appendSignalEvent(
            signal,
            'TARGET2_HIT',
            {
              price: round(quote.ltp),
              previousPrice
            }
          );
        }
      }

      signal.updatedAt = new Date().toISOString();

      activeSignals.set(signal.symbol, signal);

      persistStore();

    } catch (error) {
      signal.lastQuoteError = error.message;
      signal.lastQuoteErrorAt = new Date().toISOString();
    }

    await sleep(100);
  }
}

// =====================================
// ONE INDEX SCAN
// =====================================

async function scanOneIndex(index) {
  try {
    const candles = await getIndexCandles(
      index.futuresKey
    );

    const analysis = analyseIndex(index, candles);

    if (!analysis.optionSide) {
      activeSignals.delete(index.symbol);

      return {
        ...analysis,
        option: null
      };
    }

    const option = await selectStrongSellOption(
      index,
      analysis
    );

    const result = {
      ...analysis,
      option
    };

    if (option.success) {
      const historyRecord = addSignalToHistory(result);

      if (historyRecord) {
        activeSignals.set(index.symbol, historyRecord);

        return historyRecord;
      }
    }

    const previous = activeSignals.get(index.symbol);

    if (
      previous &&
      ['ACTIVE', 'TARGET1_HIT'].includes(previous.tradeStatus)
    ) {
      return {
        ...previous,
        ...analysis,

        option: {
          ...previous.option,
          retained: true,
          refreshNote: 'Existing deduplicated signal retained; no new signal created.'
        }
      };
    }

    return result;

  } catch (error) {
    return {
      symbol: index.symbol,
      signal: 'ERROR',
      reason: error.message
    };
  }
}

// =====================================
// FOUR INDEX MASTER SCANNER
// =====================================

async function runScan(force = false) {
  loadStore();

  if (
    !force &&
    lastScan &&
    Date.now() - lastScanAt < CONFIG.CACHE_MS
  ) {
    return lastScan;
  }

  if (scanRunning) {
    return lastScan || {
      status: 'SCANNING',
      signals: [],
      waiting: [],
      errors: []
    };
  }

  scanRunning = true;

  try {
    await loadIndexMaster();

    if (!marketIsOpenTime()) {
      const closed = {
        status: 'OUTSIDE_MARKET_HOURS',
        scanner: CONFIG.VERSION,
        marketTime: istTime(),
        confirmationTime: CONFIG.CONFIRM_AFTER,
        signals: [],
        waiting: [],
        errors: [],
        allResults: []
      };

      lastScan = closed;
      lastScanAt = Date.now();

      return closed;
    }

    if (!afterConfirmationTime()) {
      const early = {
        status: 'COLLECTING_BASELINE',
        scanner: CONFIG.VERSION,
        marketTime: istTime(),

        message:
          'Collecting 9:15 onwards live snapshots. Final signal confirmation starts at 09:30 IST.',

        signals: [],
        waiting: [],
        errors: [],
        allResults: []
      };

      lastScan = early;
      lastScanAt = Date.now();

      return early;
    }

    const results = [];

    for (const index of indexMap) {
      results.push(
        await scanOneIndex(index)
      );
    }

    await updateTradeStatuses();

    const signals = results.filter(
      x =>
        x.option?.success === true ||
        x.option?.retained === true
    );

    const data = {
      status: 'SUCCESS',
      scanner: CONFIG.VERSION,

      selectedIndexes: INDEXES,
      timeframe: '5 MINUTES',
      confirmationTime: '09:30 IST onwards',

      scanned: results.length,
      strongSellCount: signals.length,

      signals,

      waiting: results.filter(
        x =>
          x.signal === 'WAIT' ||
          (
            x.signal?.endsWith('_SELL') &&
            !x.option?.success &&
            !x.option?.retained
          )
      ),

      errors: results.filter(
        x => x.signal === 'ERROR'
      ),

      allResults: results,

      updatedAt: new Date().toISOString(),
      marketTime: istTime(),

      snapshotsInMemory: optionSnapshots.size,

      signalHistoryCount: signalHistory.length,

      activeTradeCount: signalHistory.filter(
        x =>
          ['ACTIVE', 'TARGET1_HIT'].includes(x.tradeStatus)
      ).length
    };

    lastScan = data;
    lastScanAt = Date.now();

    return data;

  } finally {
    scanRunning = false;
  }
}

// =====================================
// AUTOMATIC SERVER SCHEDULER
// =====================================

let schedulerStarted = false;

function startScheduler() {
  if (schedulerStarted) return;

  loadStore();

  schedulerStarted = true;

  setInterval(async () => {
    if (!marketIsOpenTime()) return;

    try {
      if (!masterLoaded) {
        await loadIndexMaster();
      }

      // 09:15 to 09:30: establish CE and PE baselines.

      if (!afterConfirmationTime()) {
        for (const index of indexMap) {
          try {
            const chain = await getOptionChain(
              index.indexKey
            );

            for (const row of chain.chain) {
              for (const side of ['CE', 'PE']) {
                const option = getSideOption(row, side);

                if (!option?.instrument_key) continue;

                const md = option.market_data || {};

                const ltp = Number(md.ltp || 0);
                const volume = Number(md.volume || 0);
                const oi = Number(md.oi || 0);

                if (ltp > 0 && volume > 0 && oi > 0) {
                  const key = option.instrument_key;

                  if (!optionSnapshots.has(key)) {
                    optionSnapshots.set(key, {
                      ltp,
                      volume,
                      oi,
                      time: Date.now()
                    });
                  }
                }
              }
            }

          } catch (e) {
            console.log(
              '[BASELINE ERROR]',
              index.symbol,
              e.message
            );
          }

          await sleep(250);
        }

        return;
      }

      await runScan(true);

    } catch (e) {
      console.log('[SCHEDULER ERROR]', e.message);
    }

  }, CONFIG.SCAN_INTERVAL_MS).unref?.();
}

// =====================================
// HTTP SERVER
// =====================================

const server = http.createServer(async (req, res) => {
  loadStore();

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || 'localhost'}`
  );

  try {

    // HEALTH CHECK

    if (
      url.pathname === '/' ||
      url.pathname === '/health'
    ) {
      return sendJson(res, 200, {
        status: 'OK',
        scanner: CONFIG.VERSION,

        tokenConfigured: Boolean(TOKEN),

        allowedIndexes: INDEXES,
        marketTime: istTime(),

        confirmationTime: CONFIG.CONFIRM_AFTER,

        scheduler: schedulerStarted,

        mappedIndexes: indexMap.map(x => x.symbol),

        persistentStore: DB_FILE,
        historyCount: signalHistory.length
      });
    }

    // MASTER STATUS

    if (url.pathname === '/api/status') {
      await loadIndexMaster();

      return sendJson(res, 200, {
        status: 'OK',
        scanner: CONFIG.VERSION,

        tokenConfigured: Boolean(TOKEN),
        masterLoaded,

        indexes: indexMap,

        marketTime: istTime(),

        snapshotsInMemory: optionSnapshots.size,

        activeSignals: [...activeSignals.keys()],

        historyCount: signalHistory.length,
        persistentStore: DB_FILE
      });
    }

    // MAIN SCANNER

    if (
      url.pathname === '/api/index-options-scan' ||
      url.pathname === '/api/index-sell-scan'
    ) {
      const data = await runScan(
        url.searchParams.get('force') === 'true'
      );

      return sendJson(res, 200, data);
    }

    // SIGNAL HISTORY

    if (url.pathname === '/api/signals/history') {
      const limit = Math.min(
        500,
        Math.max(1, Number(url.searchParams.get('limit') || 100))
      );

      const rows = signalHistory
        .slice(-limit)
        .reverse()
        .map(x => ({
          ...x,
          expiryCountdown: expiryCountdown(x.option?.expiry)
        }));

      return sendJson(res, 200, {
        status: 'OK',
        count: signalHistory.length,
        signals: rows
      });
    }

    // ACTIVE SIGNALS

    if (url.pathname === '/api/signals/active') {
      const active = signalHistory.filter(
        x =>
          ['ACTIVE', 'TARGET1_HIT'].includes(x.tradeStatus)
      );

      return sendJson(res, 200, {
        status: 'OK',
        count: active.length,

        signals: active.map(x => ({
          ...x,
          expiryCountdown: expiryCountdown(x.option?.expiry)
        }))
      });
    }

    // DASHBOARD ALERT EVENTS

    if (url.pathname === '/api/signals/events') {
      const after = Number(
        url.searchParams.get('after') || 0
      );

      const events = signalHistory
        .flatMap(x => x.events || [])
        .filter(e => e.eventId > after)
        .sort((a, b) => a.eventId - b.eventId);

      return sendJson(res, 200, {
        status: 'OK',
        latestEventId: lastAlertEventId,
        events
      });
    }

    // EXECUTION STATUS UPDATE
    // Manual status update only. No broker order is placed.

    if (
      url.pathname.startsWith('/api/signals/') &&
      url.pathname.endsWith('/execution')
    ) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, {
          status: 'ERROR',
          message: 'POST_REQUIRED'
        });
      }

      const parts = url.pathname.split('/');
      const id = Number(parts[3]);

      const signal = signalHistory.find(
        x => x.id === id
      );

      if (!signal) {
        return sendJson(res, 404, {
          status: 'ERROR',
          message: 'SIGNAL_NOT_FOUND'
        });
      }

      const body = await readRequestBody(req);

      const allowed = [
        'NOT_PLACED',
        'PLACED',
        'PARTIALLY_FILLED',
        'FILLED',
        'CANCELLED',
        'REJECTED'
      ];

      const status = String(
        body.status || ''
      ).toUpperCase();

      if (!allowed.includes(status)) {
        return sendJson(res, 400, {
          status: 'ERROR',
          message: 'INVALID_EXECUTION_STATUS',
          allowed
        });
      }

      signal.executionStatus = status;

      signal.executionReference =
        body.reference
          ? String(body.reference).slice(0, 100)
          : null;

      signal.executionUpdatedAt =
        new Date().toISOString();

      appendSignalEvent(
        signal,
        'EXECUTION_STATUS_UPDATED',
        {
          executionStatus: status,
          reference: signal.executionReference
        }
      );

      persistStore();

      return sendJson(res, 200, {
        status: 'OK',
        signal
      });
    }

    // STRONG OPTION SELL

    if (url.pathname === '/api/strong-option-sell') {
      const data = await runScan(false);

      return sendJson(res, 200, {
        status: data.status,
        count: data.strongSellCount || 0,
        signals: data.signals || [],
        marketTime: data.marketTime
      });
    }

    return sendJson(res, 404, {
      status: 'ERROR',
      message: 'ROUTE_NOT_FOUND'
    });

  } catch (error) {
    console.error('[SERVER ERROR]', error);

    return sendJson(res, 500, {
      status: 'ERROR',
      message: error.message
    });
  }
});

// =====================================
// START SERVER
// =====================================

server.listen(PORT, () => {
  console.log('==========================================');

  console.log(
    ' SMART MONEY PRO V4 - FOUR INDEX CE/PE + HISTORY + SL/TP'
  );

  console.log(' PORT:', PORT);
  console.log(' INDEXES:', INDEXES.join(', '));

  console.log(' 09:15 baseline | 09:30+ confirmation');

  console.log(' Persistent store:', DB_FILE);
  console.log(' History records:', signalHistory.length);

  console.log('==========================================');

  startScheduler();
});
