
"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;
const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// =====================================
// DEFAULT INDEXES
// =====================================

const DEFAULT_INDEXES = [
    "NIFTY",
    "BANKNIFTY",
    "SENSEX",
    "FINNIFTY"
];

const CONFIG = {
    VERSION: "SMART_MONEY_INDEX_SELL_V2",
    TIMEFRAME: 5,
    RSI_PERIOD: 14,
    RSI_MAX: 35,
    VOLUME_MULTIPLIER: 1.5,
    MIN_OI_CHANGE: 0.10,
    MIN_OPTION_VOLUME_CHANGE: 0,
    MAX_SPREAD_PERCENT: 2,
    STOP_LOSS_PERCENT: 25,
    TARGET1_PERCENT: 30,
    TARGET2_PERCENT: 50,
    SCAN_CACHE_MS: 10000
};

// =====================================
// GLOBAL DATA
// =====================================

let instrumentMaster = [];
let indexMap = [];
let masterLoaded = false;
let scanRunning = false;
let scanCache = null;

// Fresh snapshots. They reset when server restarts.
const optionSnapshots = new Map();

// =====================================
// INDEX SELECTION
// =====================================

function getRequestedIndexes(requested) {
    if (!requested) return [...DEFAULT_INDEXES];

    const selected = String(requested)
        .split(",")
        .map(x => x.trim().toUpperCase())
        .filter(x => DEFAULT_INDEXES.includes(x));

    return [...new Set(selected)];
}

// =====================================
// HELPERS
// =====================================

function round(value) {
    const n = Number(value);
    return Number.isFinite(n)
        ? Number(n.toFixed(2))
        : null;
}

function istDate(date = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).format(date);
}

function istTime(date = new Date()) {
    return new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    }).format(date);
}

function sendJson(res, status, data) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers":
            "Content-Type, Authorization",
        "Cache-Control": "no-store"
    });

    res.end(JSON.stringify(data));
}

// =====================================
// UPSTOX API
// =====================================

async function upstoxGET(path) {
    if (!TOKEN) {
        throw new Error("UPSTOX_ACCESS_TOKEN_MISSING");
    }

    const response = await fetch(API + path, {
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${TOKEN}`
        },
        signal: AbortSignal.timeout(25000)
    });

    const data = await response.json();

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
        throw new Error("MASTER_DOWNLOAD_FAILED");
    }

    const buffer = Buffer.from(
        await response.arrayBuffer()
    );

    let rows;

    try {
        rows = JSON.parse(
            zlib.gunzipSync(buffer).toString("utf8")
        );
    } catch {
        rows = JSON.parse(buffer.toString("utf8"));
    }

    if (!Array.isArray(rows)) {
        throw new Error("INVALID_MASTER_DATA");
    }

    return rows;
}

// =====================================
// INDEX MAPPING
// =====================================

const INDEX_ALIASES = {
    NIFTY: ["NIFTY 50", "NIFTY"],
    BANKNIFTY: ["NIFTY BANK", "BANKNIFTY"],
    SENSEX: ["SENSEX"],
    FINNIFTY: ["NIFTY FIN SERVICE", "FINNIFTY"]
};

async function loadIndexMaster() {
    if (masterLoaded) return;

    instrumentMaster = await downloadInstrumentMaster();

    const today = istDate();
    const indexes = [];

    for (const symbol of DEFAULT_INDEXES) {
        const aliases = INDEX_ALIASES[symbol];

        const indexInstrument = instrumentMaster.find(item => {
            if (
                !["NSE_INDEX", "BSE_INDEX"].includes(item.segment)
            ) return false;

            const name = String(
                item.name || item.trading_symbol || ""
            ).toUpperCase();

            return aliases.some(a =>
                name === a || name.includes(a)
            );
        });

        const futures = instrumentMaster
            .filter(item => {
                if (
                    !["NSE_FO", "BSE_FO"].includes(item.segment) ||
                    item.instrument_type !== "FUT" ||
                    !item.instrument_key ||
                    !item.expiry
                ) return false;

                const underlying = String(
                    item.underlying_symbol || item.name || ""
                ).toUpperCase();

                const matches = aliases.some(a =>
                    underlying === a ||
                    underlying.includes(a)
                );

                return matches &&
                    String(item.expiry).slice(0, 10) >= today;
            })
            .sort((a, b) =>
                String(a.expiry).localeCompare(String(b.expiry))
            );

        if (!indexInstrument || !futures.length) {
            console.log("[INDEX MISSING]", symbol);
            continue;
        }

        indexes.push({
            symbol,
            indexKey: indexInstrument.instrument_key,
            futuresKey: futures[0].instrument_key,
            futuresSymbol: futures[0].trading_symbol,
            expiry: String(futures[0].expiry).slice(0, 10),
            lotSize: Number(futures[0].lot_size || 0)
        });
    }

    indexMap = indexes;
    masterLoaded = true;

    console.log("[FOUR INDEXES LOADED]", indexMap);
}

// =====================================
// 5 MINUTE COMPLETED CANDLES
// =====================================

async function getIndexCandles(instrumentKey) {
    if (!instrumentKey) {
        throw new Error("INSTRUMENT_KEY_MISSING");
    }

    const key = encodeURIComponent(instrumentKey);

    const result = await upstoxGET(
        `/v3/historical-candle/intraday/${key}/minutes/5`
    );

    if (result.status !== "success") {
        throw new Error("CANDLE_API_FAILED");
    }

    const now = Date.now();

    return (result?.data?.candles || [])
        .map(c => ({
            time: new Date(c[0]).getTime(),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5] || 0),
            oi: Number(c[6] || 0)
        }))
        .filter(c =>
            Number.isFinite(c.time) &&
            c.close > 0 &&
            c.time + 300000 <= now
        )
        .sort((a, b) => a.time - b.time);
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
    if (candles.length < 21) return 0;

    const previous = candles.slice(-21, -1);

    const average = previous.reduce(
        (sum, c) => sum + c.volume, 0
    ) / previous.length;

    const latest = candles[candles.length - 1];

    return average > 0
        ? round(latest.volume / average)
        : 0;
}

// =====================================
// VWAP
// =====================================

function calculateVWAP(candles) {
    let totalPV = 0;
    let totalVolume = 0;

    for (const c of candles) {
        const typical =
            (c.high + c.low + c.close) / 3;

        totalPV += typical * c.volume;
        totalVolume += c.volume;
    }

    return totalVolume > 0
        ? totalPV / totalVolume
        : null;
}

// =====================================
// BEARISH CANDLE
// =====================================

function isStrongBearish(candle) {
    const range = candle.high - candle.low;

    if (range <= 0) return false;

    const body = candle.open - candle.close;

    return (
        candle.close < candle.open &&
        body / range >= 0.50
    );
}

// =====================================
// INDEX STRONG SELL ANALYSIS
// =====================================

function analyseIndex(index, candles) {
    if (!Array.isArray(candles) || candles.length < 21) {
        return {
            symbol: index.symbol,
            signal: "WAIT",
            reason: "INSUFFICIENT_CANDLES"
        };
    }

    const today = candles.filter(c =>
        istDate(new Date(c.time)) === istDate()
    );

    if (today.length < 5) {
        return {
            symbol: index.symbol,
            signal: "WAIT",
            reason: "INSUFFICIENT_TODAY_CANDLES"
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
        oiChange >= CONFIG.MIN_OI_CHANGE;

    const vwap = calculateVWAP(today);

    const priceDecrease = last.close < previous.close;

    const belowVWAP =
        vwap !== null && last.close < vwap;

    const rsiPass =
        rsi !== null && rsi <= CONFIG.RSI_MAX;

    const volumePass =
        volumeRatio >= CONFIG.VOLUME_MULTIPLIER;

    const bearishCandle = isStrongBearish(last);

    const conditions = {
        priceDecrease,
        oiIncreasing,
        volumePass,
        rsiPass,
        belowVWAP,
        bearishCandle
    };

    const score = Object.values(conditions)
        .filter(Boolean).length;

    const strongSell = score === 6;

    return {
        symbol: index.symbol,
        signal: strongSell ? "STRONG_SELL" : "WAIT",
        signalType: strongSell ? "STRONG_CE_SELL" : "WAITING",
        price: round(last.close),
        rsi,
        volumeRatio,
        oiChangePercent: round(oiChange),
        currentOI: last.oi,
        previousOI: previous.oi,
        vwap: round(vwap),
        bearishStrength: `${score}/6`,
        priceDecrease,
        oiIncreasing,
        volumePass,
        rsiPass,
        belowVWAP,
        bearishCandle,
        futuresInstrumentKey: index.futuresKey,
        indexInstrumentKey: index.indexKey,
        futuresSymbol: index.futuresSymbol,
        expiry: index.expiry,
        candleTime: istTime(new Date(last.time)),
        timeframe: "5 MINUTES",
        conditions
    };
}

// =====================================
// OPTION CHAIN
// =====================================

async function getIndexOptionChain(indexKey) {
    const key = encodeURIComponent(indexKey);

    const contracts = await upstoxGET(
        `/v2/option/contract?instrument_key=${key}`
    );

    const rows = contracts?.data || [];

    const expiries = [...new Set(
        rows.map(x => String(x.expiry || "").slice(0, 10))
            .filter(x => x >= istDate())
    )].sort();

    if (!expiries.length) {
        throw new Error("NO_OPTION_EXPIRY");
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

// =====================================
// OPTION SNAPSHOT ANALYSIS
// =====================================

function analyseOption(row, index, expiry, analysis) {
    const option = row.call_options;

    if (!option) return null;

    const market = option.market_data || {};
    const greeks = option.option_greeks || {};

    const ltp = Number(market.ltp || 0);
    const bid = Number(market.bid_price || 0);
    const ask = Number(market.ask_price || 0);
    const volume = Number(market.volume || 0);
    const oi = Number(market.oi || 0);
    const delta = Math.abs(Number(greeks.delta || 0));

    if (
        !option.instrument_key ||
        ltp <= 0 ||
        bid <= 0 ||
        ask <= 0 ||
        volume <= 0 ||
        oi <= 0 ||
        ask < bid ||
        delta < 0.40 ||
        delta > 0.70
    ) return null;

    const spreadPercent = ((ask - bid) / ltp) * 100;

    if (spreadPercent > CONFIG.MAX_SPREAD_PERCENT) {
        return null;
    }

    const instrumentKey = option.instrument_key;

    const previous = optionSnapshots.get(instrumentKey);

    // Save current snapshot for the next scan.
    optionSnapshots.set(instrumentKey, {
        ltp,
        volume,
        oi,
        time: Date.now()
    });

    // First scan establishes a fresh baseline.
    if (!previous) return null;

    const priceDecrease = ltp < previous.ltp;
    const volumeIncrease = volume > previous.volume;
    const oiIncrease = oi > previous.oi;

    const optionOIChange = previous.oi > 0
        ? ((oi - previous.oi) / previous.oi) * 100
        : 0;

    const conditions = {
        premiumDecrease: priceDecrease,
        volumeIncrease,
        oiIncrease
    };

    if (!Object.values(conditions).every(Boolean)) {
        return null;
    }

    return {
        optionType: "CE",
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
        oiChangePercent: round(optionOIChange),
        delta: round(greeks.delta),
        spreadPercent: round(spreadPercent),
        priceDecrease,
        volumeIncrease,
        oiIncrease,
        conditions
    };
}

// =====================================
// STRONG CE SELL STRIKE SELECTION
// =====================================

async function selectCESell(index, analysis) {
    const optionData = await getIndexOptionChain(
        index.indexKey
    );

    const candidates = [];

    for (const row of optionData.chain) {
        const candidate = analyseOption(
            row,
            index,
            optionData.expiry,
            analysis
        );

        if (candidate) {
            candidates.push(candidate);
        }
    }

    if (!candidates.length) {
        return {
            success: false,
            reason: "WAITING_FOR_OPTION_PRICE_OI_VOLUME_CONFIRMATION"
        };
    }

    // Select liquid CE near ATM with bearish premium movement.
    candidates.sort((a, b) => {
        const scoreA =
            (a.volume / (1 + a.spreadPercent)) /
            (1 + Math.abs(a.delta - 0.50));

        const scoreB =
            (b.volume / (1 + b.spreadPercent)) /
            (1 + Math.abs(b.delta - 0.50));

        return scoreB - scoreA;
    });

    const best = candidates[0];

    const entry = best.entry;

    return {
        success: true,
        signal: "STRONG_CE_SELL",
        optionType: "CE",
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
        oiChangePercent: best.oiChangePercent,
        delta: best.delta,
        spreadPercent: best.spreadPercent,
        conditions: best.conditions,
        note: "CE SELL - VERIFY LIVE BID BEFORE ENTRY"
    };
}

// =====================================
// INDEX OPTION SCANNER
// =====================================

async function scanIndexOptions(index, analysis) {
    if (analysis.signal !== "STRONG_SELL") {
        return {
            success: false,
            reason: "INDEX_STRONG_SELL_NOT_CONFIRMED"
        };
    }

    return await selectCESell(index, analysis);
}

// =====================================
// MAIN FOUR INDEX SCAN
// =====================================

async function runIndexSellScan(
    requestedIndexes = DEFAULT_INDEXES,
    force = false
) {
    const selected = getRequestedIndexes(
        requestedIndexes.join(",")
    );

    const cacheKey = selected.join(",");

    if (
        !force &&
        scanCache &&
        scanCache.key === cacheKey &&
        Date.now() - scanCache.time < CONFIG.SCAN_CACHE_MS
    ) {
        return scanCache.data;
    }

    if (scanRunning) {
        if (scanCache && scanCache.key === cacheKey) {
            return scanCache.data;
        }

        throw new Error("SCAN_ALREADY_RUNNING");
    }

    scanRunning = true;

    try {
        await loadIndexMaster();

        const results = [];

        const selectedMap = indexMap.filter(index =>
            selected.includes(index.symbol)
        );

        for (const index of selectedMap) {
            try {
                const candles = await getIndexCandles(
                    index.futuresKey
                );

                const analysis = analyseIndex(
                    index,
                    candles
                );

                let option = null;

                if (analysis.signal === "STRONG_SELL") {
                    option = await scanIndexOptions(
                        index,
                        analysis
                    );
                }

                results.push({
                    ...analysis,
                    option
                });

            } catch (error) {
                results.push({
                    symbol: index.symbol,
                    signal: "ERROR",
                    reason: error.message
                });
            }
        }

        const strongSignals = results.filter(x =>
            x.signal === "STRONG_SELL" &&
            x.option?.success === true
        );

        const data = {
            status: "SUCCESS",
            scanner: CONFIG.VERSION,
            selectedIndexes: selected,
            timeframe: "5 MINUTES",
            scanned: results.length,
            strongSellCount: strongSignals.length,
            signals: strongSignals,
            waiting: results.filter(x =>
                x.signal === "WAIT" ||
                (x.signal === "STRONG_SELL" &&
                 x.option?.success !== true)
            ),
            errors: results.filter(x =>
                x.signal === "ERROR"
            ),
            allResults: results,
            updatedAt: new Date().toISOString(),
            marketTime: istTime()
        };

        scanCache = {
            key: cacheKey,
            time: Date.now(),
            data
        };

        return data;

    } finally {
        scanRunning = false;
    }
}

// =====================================
// HTTP SERVER
// =====================================

const server = http.createServer(async (req, res) => {

    if (req.method === "OPTIONS") {
        res.writeHead(204, {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS"
        });
        return res.end();
    }

    const url = new URL(
        req.url,
        `http://${req.headers.host || "localhost"}`
    );

    try {

        // HEALTH CHECK
        if (
            url.pathname === "/" ||
            url.pathname === "/health"
        ) {
            return sendJson(res, 200, {
                status: "OK",
                scanner: CONFIG.VERSION,
                tokenConfigured: Boolean(TOKEN),
                allowedIndexes: DEFAULT_INDEXES,
                marketTime: istTime()
            });
        }

        // MASTER STATUS
        if (url.pathname === "/api/status") {
            await loadIndexMaster();

            return sendJson(res, 200, {
                status: "OK",
                scanner: CONFIG.VERSION,
                tokenConfigured: Boolean(TOKEN),
                masterLoaded,
                indexes: indexMap
            });
        }

        // ONLY FOUR INDEXES
        if (url.pathname === "/api/index-sell-scan") {

            const requested = getRequestedIndexes(
                url.searchParams.get("indexes")
            );

            const force =
                url.searchParams.get("force") === "true";

            const data = await runIndexSellScan(
                requested,
                force
            );

            return sendJson(res, 200, data);
        }

        // STRONG SELL ONLY
        if (url.pathname === "/api/strong-ce-sell") {

            const data = await runIndexSellScan(
                DEFAULT_INDEXES,
                false
            );

            return sendJson(res, 200, {
                status: data.status,
                count: data.strongSellCount,
                signals: data.signals
            });
        }

        return sendJson(res, 404, {
            status: "ERROR",
            message: "ROUTE_NOT_FOUND"
        });

    } catch (error) {
        console.error("[INDEX SELL ERROR]", error);

        return sendJson(res, 500, {
            status: "ERROR",
            message: error.message
        });
    }
});

// =====================================
// START SERVER
// =====================================

server.listen(PORT, () => {
    console.log(
        "SMART MONEY PRO INDEX SELL V2 RUNNING",
        PORT
    );
    console.log("INDEXES:", DEFAULT_INDEXES);
});
            
