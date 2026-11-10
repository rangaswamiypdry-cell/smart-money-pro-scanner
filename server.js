// =================================================
// SMART TRADE INDIA
// BETA 2.0 VERY STRONG MOMENTUM ENGINE
// PART 1
// NODE.JS 20+
// =================================================

"use strict";

const BETA_CONFIG = {
    benchmark: "NSE_INDEX|Nifty 50",
    betaMinimum: 2.0,
    betaPeriod: 60,

    timeframe: 5,

    rsiBullish: 65,
    rsiBearish: 35,

    volumeMultiplier: 1.5,
    emaPeriod: 20,

    minimumCandles: 25
};

// ================================================
// UPSTOX API
// ================================================

async function betaApiRequest(url) {

    const token = process.env.UPSTOX_ACCESS_TOKEN;

    if (!token) {
        throw new Error("UPSTOX_ACCESS_TOKEN missing");
    }

    const response = await fetch(url, {
        headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json"
        },
        signal: AbortSignal.timeout(20000)
    });

    if (!response.ok) {
        throw new Error(
            `Upstox API Error: ${response.status}`
        );
    }

    const json = await response.json();

    if (json.status !== "success") {
        throw new Error("Invalid Upstox response");
    }

    return json.data.candles || [];
}

// ================================================
// DAILY HISTORICAL CANDLES
// ================================================

async function getBetaDailyCandles(instrumentKey) {

    const to = new Date();

    const from = new Date();
    from.setDate(from.getDate() - 120);

    const formatDate = d =>
        d.toISOString().slice(0, 10);

    const url =
        "https://api.upstox.com/v3/historical-candle/" +
        encodeURIComponent(instrumentKey) +
        "/days/1/" +
        formatDate(to) + "/" +
        formatDate(from);

    return await betaApiRequest(url);
}

// ================================================
// RETURN CALCULATION
// ================================================

function betaReturns(candles) {

    const sorted = [...candles].sort(
        (a, b) =>
            new Date(a[0]) - new Date(b[0])
    );

    const returns = [];

    for (let i = 1; i < sorted.length; i++) {

        const previous = Number(sorted[i - 1][4]);
        const current = Number(sorted[i][4]);

        if (previous <= 0 || current <= 0) continue;

        returns.push(current / previous - 1);
    }

    return returns;
}

// ================================================
// BETA CALCULATION
// ================================================

function calculateBeta(stockCandles, indexCandles) {

    const stock = betaReturns(stockCandles);
    const index = betaReturns(indexCandles);

    const n = Math.min(
        stock.length,
        index.length
    );

    if (n < BETA_CONFIG.betaPeriod) {
        return null;
    }

    const s = stock.slice(-BETA_CONFIG.betaPeriod);
    const m = index.slice(-BETA_CONFIG.betaPeriod);

    const mean = arr =>
        arr.reduce((a, b) => a + b, 0) / arr.length;

    const stockMean = mean(s);
    const marketMean = mean(m);

    let covariance = 0;
    let variance = 0;

    for (let i = 0; i < n; i++) {

        covariance +=
            (s[i] - stockMean) *
            (m[i] - marketMean);

        variance +=
            Math.pow(m[i] - marketMean, 2);
    }

    if (variance === 0) return null;

    return Number(
        (covariance / variance).toFixed(2)
    );
}

// ================================================
// RSI CALCULATION
// ================================================

function betaRSI(closes, period = 14) {

    if (closes.length <= period) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change = closes[i] - closes[i - 1];

        if (change > 0) gains += change;
        else losses -= change;
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {

        const change = closes[i] - closes[i - 1];

        avgGain =
            (avgGain * (period - 1) + Math.max(change, 0))
            / period;

        avgLoss =
            (avgLoss * (period - 1) + Math.max(-change, 0))
            / period;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return Number(
        (100 - 100 / (1 + rs)).toFixed(2)
    );
}

// ================================================
// EMA CALCULATION
// ================================================

function betaEMA(values, period = 20) {

    if (values.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema = values
        .slice(0, period)
        .reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < values.length; i++) {

        ema =
            (values[i] - ema) * multiplier + ema;
    }

    return ema;
}

console.log(
    // ======================================================
// SMART TRADE INDIA
// BETA 2.0 VERY STRONG MOMENTUM SCANNER
// PART 2 FULL CODE
// NSE F&O + UPSTOX V3
// ======================================================

const betaZlib = require("zlib");

const BETA_INDEX_KEY = "NSE_INDEX|Nifty 50";

let betaInstrumentCache = [];
let betaInstrumentCacheTime = 0;

const betaDailyCache = new Map();

const BETA_CACHE_TIME = 6 * 60 * 60 * 1000;

// ======================================================
// NSE F&O STOCK MASTER
// ======================================================

async function loadBetaFnoStocks() {

    if (
        betaInstrumentCache.length &&
        Date.now() - betaInstrumentCacheTime < 86400000
    ) {
        return betaInstrumentCache;
    }

    const url =
        "https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

    const response = await fetch(url);

    if (!response.ok) {
        throw new Error("NSE FNO Instrument Download Failed");
    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    const jsonText = betaZlib
        .gunzipSync(buffer)
        .toString("utf8");

    const instruments = JSON.parse(jsonText);

    const fnoSymbols = new Set();
    const equityMap = new Map();

    for (const item of instruments) {

        if (
            item.segment === "NSE_FO" &&
            item.instrument_type === "FUT" &&
            item.underlying_symbol
        ) {
            fnoSymbols.add(item.underlying_symbol);
        }

        if (
            item.segment === "NSE_EQ" &&
            item.instrument_type === "EQ" &&
            item.trading_symbol &&
            item.instrument_key
        ) {
            equityMap.set(
                item.trading_symbol,
                item.instrument_key
            );
        }
    }

    betaInstrumentCache = [...fnoSymbols]
        .map(symbol => ({
            symbol,
            instrumentKey: equityMap.get(symbol)
        }))
        .filter(stock => stock.instrumentKey);

    betaInstrumentCacheTime = Date.now();

    return betaInstrumentCache;
}

// ======================================================
// DATE ALIGNED BETA CALCULATION
// ======================================================

function betaCalculateAligned(stockCandles, indexCandles) {

    const stockMap = new Map();

    for (const candle of stockCandles) {

        const date = String(candle[0]).slice(0, 10);

        stockMap.set(date, Number(candle[4]));
    }

    const pairs = [];

    for (const candle of indexCandles) {

        const date = String(candle[0]).slice(0, 10);

        const stockClose = stockMap.get(date);
        const indexClose = Number(candle[4]);

        if (
            Number.isFinite(stockClose) &&
            stockClose > 0 &&
            Number.isFinite(indexClose) &&
            indexClose > 0
        ) {
            pairs.push({
                date,
                stockClose,
                indexClose
            });
        }
    }

    pairs.sort((a, b) =>
        a.date.localeCompare(b.date)
    );

    if (pairs.length < 61) return null;

    const stockReturns = [];
    const indexReturns = [];

    for (let i = 1; i < pairs.length; i++) {

        stockReturns.push(
            pairs[i].stockClose /
            pairs[i - 1].stockClose - 1
        );

        indexReturns.push(
            pairs[i].indexClose /
            pairs[i - 1].indexClose - 1
        );
    }

    const stock = stockReturns.slice(-60);
    const market = indexReturns.slice(-60);

    const mean = arr =>
        arr.reduce((a, b) => a + b, 0) / arr.length;

    const stockMean = mean(stock);
    const marketMean = mean(market);

    let covariance = 0;
    let variance = 0;

    for (let i = 0; i < 60; i++) {

        covariance +=
            (stock[i] - stockMean) *
            (market[i] - marketMean);

        variance += Math.pow(
            market[i] - marketMean,
            2
        );
    }

    if (variance === 0) return null;

    return Number(
        (covariance / variance).toFixed(2)
    );
}

// ======================================================
// CACHED BETA
// ======================================================

async function getCachedBeta(stockKey) {

    const cached = betaDailyCache.get(stockKey);

    if (
        cached &&
        Date.now() - cached.time < BETA_CACHE_TIME
    ) {
        return cached.beta;
    }

    const [stockCandles, indexCandles] =
        await Promise.all([
            getBetaDailyCandles(stockKey),
            getBetaDailyCandles(BETA_INDEX_KEY)
        ]);

    const beta = betaCalculateAligned(
        stockCandles,
        indexCandles
    );

    betaDailyCache.set(stockKey, {
        beta,
        time: Date.now()
    });

    return beta;
}

// ======================================================
// 5 MINUTE INTRADAY CANDLES
// ======================================================

async function getBetaIntradayCandles(instrumentKey) {

    const url =
        "https://api.upstox.com/v3/historical-candle/intraday/" +
        encodeURIComponent(instrumentKey) +
        "/minutes/5";

    return await betaApiRequest(url);
}

// ======================================================
// VWAP
// ======================================================

function calculateBetaVWAP(candles) {

    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {

        const high = Number(c[2]);
        const low = Number(c[3]);
        const close = Number(c[4]);
        const volume = Number(c[5]);

        if (
            ![high, low, close, volume].every(Number.isFinite) ||
            volume <= 0
        ) continue;

        const typicalPrice =
            (high + low + close) / 3;

        totalPV += typicalPrice * volume;
        totalVolume += volume;
    }

    return totalVolume > 0
        ? totalPV / totalVolume
        : null;
}

// ======================================================
// MOMENTUM ANALYSIS
// ======================================================

function analyseBetaMomentum(rawCandles, beta) {

    const now = Date.now();

    const candles = rawCandles
        .filter(c => {
            const time = new Date(c[0]).getTime();

            return Number.isFinite(time) &&
                time + 300000 <= now;
        })
        .sort((a, b) =>
            new Date(a[0]) - new Date(b[0])
        );

    if (candles.length < 25) return null;

    const closes = candles.map(c => Number(c[4]));

    const latest = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    const close = Number(latest[4]);
    const previousClose = Number(previous[4]);

    const volume = Number(latest[5]);

    const previousVolumes = candles
        .slice(-21, -1)
        .map(c => Number(c[5]));

    const averageVolume =
        previousVolumes.reduce((a, b) => a + b, 0) /
        previousVolumes.length;

    if (
        !Number.isFinite(averageVolume) ||
        averageVolume <= 0
    ) return null;

    const volumeRatio = volume / averageVolume;

    const volumePass = volumeRatio >= 1.5;

    const rsi = betaRSI(closes);
    const ema = betaEMA(closes, 20);
    const vwap = calculateBetaVWAP(candles);

    if (
        rsi === null ||
        ema === null ||
        vwap === null
    ) return null;

    const bullish =
        beta >= 2.0 &&
        close > ema &&
        close > vwap &&
        close > previousClose &&
        rsi >= 65 &&
        volumePass;

    const bearish =
        beta >= 2.0 &&
        close < ema &&
        close < vwap &&
        close < previousClose &&
        rsi <= 35 &&
        volumePass;

    let signal = "NO_SIGNAL";

    if (bullish) {
        signal = "VERY_STRONG_BUY";
    } else if (bearish) {
        signal = "VERY_STRONG_SELL";
    }

    return {
        beta,
        price: close,
        rsi,
        ema20: Number(ema.toFixed(2)),
        vwap: Number(vwap.toFixed(2)),
        volume,
        averageVolume: Math.round(averageVolume),
        volumeRatio: Number(volumeRatio.toFixed(2)),
        signal,
        candleTime: latest[0]
    };
}

// ======================================================
// SCANNER WORKER POOL
// ======================================================

async function runBetaPool(
    items,
    worker,
    concurrency = 3
) {

    const results = [];

    let next = 0;

    async function runWorker() {

        while (next < items.length) {

            const index = next++;

            try {

                const result = await worker(items[index]);

                if (result) results.push(result);

            } catch (error) {

                console.error(
                    "BETA STOCK ERROR:",
                    items[index].symbol,
                    error.message
                );
            }
        }
    }

    await Promise.all(
        Array.from(
            { length: concurrency },
            () => runWorker()
        )
    );

    return results;
}

// ======================================================
// MAIN SCANNER
// ======================================================

async function runBetaStrongMomentumScanner() {

    const stocks = await loadBetaFnoStocks();

    const results = await runBetaPool(
        stocks,

        async stock => {

            const beta = await getCachedBeta(
                stock.instrumentKey
            );

            if (beta === null || beta < 2.0) {
                return null;
            }

            const candles = await getBetaIntradayCandles(
                stock.instrumentKey
            );

            const analysis = analyseBetaMomentum(
                candles,
                beta
            );

            if (
                !analysis ||
                analysis.signal === "NO_SIGNAL"
            ) {
                return null;
            }

            return {
                symbol: stock.symbol,
                instrumentKey: stock.instrumentKey,
                ...analysis
            };
        },

        3
    );

    results.sort(
        (a, b) => b.volumeRatio - a.volumeRatio
    );

    return {
        status: "success",
        scanner: "BETA_2.0_VERY_STRONG_MOMENTUM",
        benchmark: "NIFTY 50",
        timeframe: "5 MINUTES",
        totalFnoStocks: stocks.length,
        totalSignals: results.length,
        signals: results,
        updatedAt: new Date().toISOString()
    };
}

// ======================================================
// API ROUTE
// ======================================================

async function handleBetaScannerRoute(req, res) {

    const url = new URL(
        req.url,
        "http://localhost"
    );

    if (
        req.method !== "GET" ||
        url.pathname !== "/api/beta/strong-momentum"
    ) {
        return false;
    }

    try {

        const result =
            await runBetaStrongMomentumScanner();

        res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store"
        });

        res.end(JSON.stringify(result));

    } catch (error) {

        console.error("BETA SCANNER ERROR:", error);

        res.writeHead(500, {
            "Content-Type": "application/json"
        });

        res.end(JSON.stringify({
            status: "error",
            message: error.message
        }));
    }

    return true;
}

console.log(
    "SMART TRADE INDIA BETA 2.0 PART 2 LOADED"
);
