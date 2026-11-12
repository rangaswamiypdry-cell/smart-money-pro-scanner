// ==============================================
// SMART MONEY PRO INDEX SELLING V1
// PART 1 OF 2
// ==============================================

"use strict";

const http = require("http");
const zlib = require("zlib");

const PORT = process.env.PORT || 10000;

const TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";

const API = "https://api.upstox.com";

const MASTER_URL =
"https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz";

// ==============================================
// CONFIGURATION
// ==============================================

const INDEX_SELL_CONFIG = {

    VERSION: "INDEX_SELL_PRO_V1",

    TIMEFRAME: 5,

    RSI_PERIOD: 14,

    RSI_MAX: 35,

    VOLUME_MULTIPLIER: 2,

    MIN_OI_CHANGE: 1,

    INDEXES: [
        "NIFTY",
        "BANKNIFTY",
        "SENSEX",
        "FINNIFTY"
    ],

    STOP_LOSS_PERCENT: 25,

    TARGET1_PERCENT: 30,

    TARGET2_PERCENT: 50,

    REQUIRE_COMPLETED_CANDLE: true

};

// ==============================================
// GLOBAL VARIABLES
// ==============================================

let instrumentMaster = [];

let indexFutures = [];

let indexMap = [];

let masterLoaded = false;

let scanRunning = false;

let scanCache = null;

// ==============================================
// HELPERS
// ==============================================

function round(value) {

    const n = Number(value);

    return Number.isFinite(n)
        ? Number(n.toFixed(2))
        : null;
}

function istTime(date = new Date()) {

    return new Intl.DateTimeFormat(
        "en-GB",
        {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }
    ).format(date);
}

function istDate(date = new Date()) {

    return new Intl.DateTimeFormat(
        "en-CA",
        {
            timeZone: "Asia/Kolkata",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
        }
    ).format(date);
}

// ==============================================
// UPSTOX API
// ==============================================

async function upstoxGET(path) {

    if (!TOKEN) {
        throw new Error(
            "UPSTOX_ACCESS_TOKEN missing"
        );
    }

    const response = await fetch(
        API + path,
        {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${TOKEN}`
            },
            signal: AbortSignal.timeout(20000)
        }
    );

    const data = await response.json();

    if (!response.ok) {

        throw new Error(
            data?.errors?.[0]?.message ||
            data?.message ||
            `UPSTOX ERROR ${response.status}`
        );
    }

    return data;
}

// ==============================================
// DOWNLOAD INSTRUMENT MASTER
// ==============================================

async function downloadInstrumentMaster() {

    const response = await fetch(
        MASTER_URL,
        {
            signal: AbortSignal.timeout(60000)
        }
    );

    if (!response.ok) {
        throw new Error(
            "INSTRUMENT MASTER DOWNLOAD FAILED"
        );
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

        rows = JSON.parse(
            buffer.toString("utf8")
        );
    }

    if (!Array.isArray(rows)) {
        throw new Error("INVALID INSTRUMENT MASTER");
    }

    return rows;
}

// ==============================================
// INDEX INSTRUMENT MAPPING
// ==============================================

async function loadIndexMaster() {

    if (masterLoaded) return;

    instrumentMaster =
        await downloadInstrumentMaster();

    const indexes = {};

    for (const item of instrumentMaster) {

        if (
            ["NSE_INDEX", "BSE_INDEX"].includes(item.segment) &&
            item.instrument_type === "INDEX"
        ) {

            const symbol = String(
                item.trading_symbol ||
                item.name ||
                ""
            ).toUpperCase();

            indexes[symbol] = item;
        }
    }

    const aliases = {

        NIFTY: ["NIFTY 50", "NIFTY"],

        BANKNIFTY: ["NIFTY BANK", "BANKNIFTY"],

        SENSEX: ["SENSEX"],

        FINNIFTY: ["NIFTY FIN SERVICE", "FINNIFTY"]

    };

    const futures = instrumentMaster.filter(item =>

        ["NSE_FO", "BSE_FO"].includes(item.segment) &&

        item.instrument_type === "FUT" &&

        item.instrument_key &&

        item.expiry

    );

    const today = istDate();

    indexMap = [];

    for (const symbol of INDEX_SELL_CONFIG.INDEXES) {

        const matching = futures.filter(item => {

            const underlying = String(
                item.underlying_symbol || ""
            ).toUpperCase();

            const name = String(
                item.name || ""
            ).toUpperCase();

            const matches =
                aliases[symbol].includes(underlying) ||
                aliases[symbol].some(alias =>
                    name.includes(alias)
                );

            return matches &&
                String(item.expiry).slice(0, 10) >= today;
        });

        matching.sort((a, b) =>
            String(a.expiry).localeCompare(
                String(b.expiry)
            )
        );

        const future = matching[0];

        if (!future) {

            console.log(
                "[INDEX NOT FOUND]",
                symbol
            );

            continue;
        }

        const indexInstrument = Object.values(indexes).find(
            item => {

                const name = String(
                    item.name || item.trading_symbol || ""
                ).toUpperCase();

                return aliases[symbol].some(alias =>
                    name.includes(alias)
                );
            }
        );

        if (!indexInstrument) {

            console.log(
                "[INDEX KEY NOT FOUND]",
                symbol
            );

            continue;
        }

        indexMap.push({

            symbol,

            indexKey:
                indexInstrument.instrument_key,

            futuresKey:
                future.instrument_key,

            futuresSymbol:
                future.trading_symbol,

            expiry:
                String(future.expiry).slice(0, 10),

            lotSize:
                Number(future.lot_size || 0)

        });
    }

    masterLoaded = true;

    console.log(
        "[INDEX MASTER LOADED]",
        indexMap
    );
}

// ==============================================
// GET 5 MINUTE FUTURES CANDLES
// ==============================================

async function getIndexCandles(instrumentKey) {

    const key = encodeURIComponent(
        instrumentKey
    );

    const result = await upstoxGET(

        `/v3/historical-candle/intraday/${key}/minutes/5`

    );

    const raw = result?.data?.candles || [];

    const now = Date.now();

    return raw.map(c => ({

        time: new Date(c[0]).getTime(),

        open: Number(c[1]),

        high: Number(c[2]),

        low: Number(c[3]),

        close: Number(c[4]),

        volume: Number(c[5] || 0),

        oi: Number(c[6] || 0)

    })).filter(c =>

        Number.isFinite(c.time) &&

        c.time + 5 * 60 * 1000 <= now

    ).sort((a, b) => a.time - b.time);
}

// ==============================================
// RSI CALCULATION
// ==============================================

function calculateRSI(closes, period = 14) {

    if (closes.length <= period) return null;

    let gains = 0;

    let losses = 0;

    for (let i = 1; i <= period; i++) {

        const change =
            closes[i] - closes[i - 1];

        if (change > 0) gains += change;

        else losses -= change;
    }

    let avgGain = gains / period;

    let avgLoss = losses / period;

    for (
        let i = period + 1;
        i < closes.length;
        i++
    ) {

        const change =
            closes[i] - closes[i - 1];

        avgGain =
            (
                avgGain * (period - 1) +
                Math.max(change, 0)
            ) / period;

        avgLoss =
            (
                avgLoss * (period - 1) +
                Math.max(-change, 0)
            ) / period;
    }

    if (avgLoss === 0) return 100;

    return round(
        100 - 100 / (1 + avgGain / avgLoss)
    );
}

// ==============================================
// SESSION VWAP
// ==============================================

function calculateSessionVWAP(candles) {

    let pv = 0;

    let volume = 0;

    for (const c of candles) {

        const typical =
            (c.high + c.low + c.close) / 3;

        pv += typical * c.volume;

        volume += c.volume;
    }

    if (volume <= 0) return null;

    return pv / volume;
}

// ==============================================
// VOLUME ANALYSIS
// ==============================================

function calculateVolumeRatio(candles) {

    if (candles.length < 21) return 0;

    const previous = candles.slice(-21, -1);

    const average =
        previous.reduce(
            (sum, c) => sum + c.volume,
            0
        ) / previous.length;

    const latest = candles[candles.length - 1];

    return average > 0
        ? round(latest.volume / average)
        : 0;
}

// ==============================================
// BEARISH CANDLE
// ==============================================

function isStrongBearish(candle) {

    const range = candle.high - candle.low;

    if (range <= 0) return false;

    const body = candle.open - candle.close;

    return (
        candle.close < candle.open &&
        body / range >= 0.50
    );
}

// ==============================================
// INDEX STRONG SELL ANALYSIS
// ==============================================

function analyseIndex(index, candles) {

    if (!Array.isArray(candles) ||
        candles.length < 21) {

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

    const closes = candles.map(c => c.close);

    const rsi = calculateRSI(
        closes,
        INDEX_SELL_CONFIG.RSI_PERIOD
    );

    const volumeRatio =
        calculateVolumeRatio(candles);

    // Intraday OI change between completed candles.

    const oiChange =
        previous.oi > 0
            ? (
                (last.oi - previous.oi) /
                previous.oi
            ) * 100
            : null;

    const oiIncreasing =
        oiChange !== null &&
        oiChange >= INDEX_SELL_CONFIG.MIN_OI_CHANGE;

    // Calculate VWAP before and after latest candle.

    const previousVWAP =
        calculateSessionVWAP(
            today.slice(0, -1)
        );

    const currentVWAP =
        calculateSessionVWAP(today);

    const vwapCrossDown =
        previousVWAP !== null &&
        currentVWAP !== null &&
        previous.close >= previousVWAP &&
        last.close < currentVWAP;

    const priceDecrease =
        last.close < previous.close;

    const rsiPass =
        rsi !== null &&
        rsi <= INDEX_SELL_CONFIG.RSI_MAX;

    const volumePass =
        volumeRatio >=
        INDEX_SELL_CONFIG.VOLUME_MULTIPLIER;

    const bearishCandle =
        isStrongBearish(last);

    const conditions = {

        priceDecrease,

        oiIncreasing,

        volumePass,

        rsiPass,

        vwapCrossDown,

        bearishCandle

    };

    const strongSell =
        Object.values(conditions).every(Boolean);

    return {

        symbol: index.symbol,

        signal: strongSell
            ? "STRONG_CE_SELL"
            : "WAIT",

        signalType: strongSell
            ? "STRONG_SELL"
            : "WAITING",

        price: round(last.close),

        rsi,

        volumeRatio,

        oiChangePercent: round(oiChange),

        currentOI: last.oi,

        previousOI: previous.oi,

        vwap: round(currentVWAP),

        previousVWAP: round(previousVWAP),

        vwapCrossDown,

        priceDecrease,

        oiIncreasing,

        volumePass,

        rsiPass,

        bearishCandle,

        futuresInstrumentKey:
            index.futuresKey,

        indexInstrumentKey:
            index.indexKey,

        futuresSymbol:
            index.futuresSymbol,

        expiry:
            index.expiry,

        candleTime:
            istTime(new Date(last.time)),

        timeframe: "5 MINUTES",

        conditions

    };
}

// ==============================================
// OPTION CONTRACTS
// ==============================================

async function getIndexOptionChain(indexKey) {

    const key = encodeURIComponent(indexKey);

    const contracts = await upstoxGET(
        `/v2/option/contract?instrument_key=${key}`
    );

    const rows = contracts?.data || [];

    const expiries = [...new Set(
        rows.map(x =>
            String(x.expiry || "").slice(0, 10)
        ).filter(x =>
            /^\d{4}-\d{2}-\d{2}$/.test(x) &&
            x >= istDate()
        )
    )].sort();

    if (!expiries.length) {
        throw new Error("NO_VALID_OPTION_EXPIRY");
    }

    const expiry = expiries[0];

    const chain = await upstoxGET(
        `/v2/option/chain?instrument_key=${key}&expiry_date=${expiry}`
    );

    return {
        expiry,
        contracts: rows,
        chain: chain?.data || []
    };
}

// ==============================================
// SELECT CE SELL CONTRACT
// ==============================================

async function selectCESell(index, signal) {

    const optionData =
        await getIndexOptionChain(index.indexKey);

    const candidates = [];

    for (const row of optionData.chain) {

        const option = row.call_options;

        if (!option) continue;

        const market = option.market_data || {};

        const greeks = option.option_greeks || {};

        const ltp = Number(market.ltp || 0);

        const bid = Number(market.bid_price || 0);

        const ask = Number(market.ask_price || 0);

        const volume = Number(market.volume || 0);

        const oi = Number(market.oi || 0);

        const delta = Math.abs(
            Number(greeks.delta || 0)
        );

        if (
            ltp <= 0 ||
            bid <= 0 ||
            ask <= 0 ||
            volume <= 0 ||
            oi <= 0 ||
            ask < bid ||
            delta < 0.40 ||
            delta > 0.70
        ) continue;

        const spreadPercent =
            ((ask - bid) / ltp) * 100;

        if (spreadPercent > 2) continue;

        candidates.push({

            strike: Number(row.strike_price),

            instrumentKey:
                option.instrument_key,

            premium: ltp,

            entry: bid,

            bid,

            ask,

            volume,

            oi,

            delta: round(greeks.delta),

            spreadPercent: round(spreadPercent)

        });
    }

    if (!candidates.length) {

        throw new Error(
            "NO_LIQUID_CE_CONTRACT_FOUND"
        );
    }

    // Prefer liquid contract with lowest spread.

    candidates.sort((a, b) => {

        const scoreA =
            a.volume / (1 + a.spreadPercent);

        const scoreB =
            b.volume / (1 + b.spreadPercent);

        return scoreB - scoreA;
    });

    const best = candidates[0];

    const entry = best.entry;

    const stopLoss = round(
        entry * (
            1 +
            INDEX_SELL_CONFIG.STOP_LOSS_PERCENT / 100
        )
    );

    const target1 = round(
        entry * (
            1 -
            INDEX_SELL_CONFIG.TARGET1_PERCENT / 100
        )
    );

    const target2 = round(
        entry * (
            1 -
            INDEX_SELL_CONFIG.TARGET2_PERCENT / 100
        )
    );

    return {

        signal: "STRONG_CE_SELL",

        optionType: "CE",

        strikePrice: best.strike,

        instrumentKey: best.instrumentKey,

        expiry: optionData.expiry,

        premium: best.premium,

        entry,

        stopLoss,

        target1,

        target2,

        volume: best.volume,

        oi: best.oi,

        delta: best.delta,

        spreadPercent: best.spreadPercent,

        riskReward: "1:1.2 / 1:2",

        note: "SELL ENTRY AT BID PRICE"

    };
}

// ==============================================
// MAIN INDEX SCANNER
// ==============================================

async function runIndexSellScan(force = false) {

    if (
        !force &&
        scanCache &&
        Date.now() - scanCache.time < 10000
    ) {
        return scanCache.data;
    }

    if (scanRunning) {

        if (scanCache) return scanCache.data;

        throw new Error("SCAN_ALREADY_RUNNING");
    }

    scanRunning = true;

    try {

        await loadIndexMaster();

        const results = [];

        for (const index of indexMap) {

            try {

                const candles =
                    await getIndexCandles(
                        index.futuresKey
                    );

                const analysis =
                    analyseIndex(index, candles);

                let option = null;

                if (
                    analysis.signal === "STRONG_CE_SELL"
                ) {

                    try {

                        option = await selectCESell(
                            index,
                            analysis
                        );

                    } catch (error) {

                        analysis.optionError =
                            error.message;
                    }
                }

                results.push({

                    ...analysis,

                    option

                });

            } catch (error) {

                results.push({

                    symbol: index.symbol,

                    signal: "WAIT",

                    reason: error.message

                });
            }
        }

        const strongSignals = results.filter(x =>

            x.signal === "STRONG_CE_SELL" &&
            x.option?.success !== false &&
            x.option?.instrumentKey

        );

        const data = {

            status: "SUCCESS",

            scanner:
                INDEX_SELL_CONFIG.VERSION,

            timeframe: "5 MINUTES",

            scanned: results.length,

            strongSellCount:
                strongSignals.length,

            signals: strongSignals,

            waiting: results.filter(x =>
                x.signal === "WAIT"
            ),

            allResults: results,

            updatedAt:
                new Date().toISOString(),

            marketTime: istTime()

        };

        scanCache = {

            time: Date.now(),

            data

        };

        return data;

    } finally {

        scanRunning = false;

    }
}

// ==============================================
// JSON RESPONSE
// ==============================================

function sendJson(res, status, data) {

    res.writeHead(status, {

        "Content-Type":
            "application/json; charset=utf-8",

        "Access-Control-Allow-Origin": "*",

        "Access-Control-Allow-Methods":
            "GET, OPTIONS",

        "Access-Control-Allow-Headers":
            "Content-Type, Authorization",

        "Cache-Control": "no-store"

    });

    res.end(JSON.stringify(data));
}

// ==============================================
// API ROUTES
// ==============================================

const server = http.createServer(
    async (req, res) => {

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

            if (
                url.pathname === "/" ||
                url.pathname === "/health"
            ) {

                return sendJson(res, 200, {

                    status: "OK",

                    scanner:
                        INDEX_SELL_CONFIG.VERSION,

                    tokenConfigured:
                        Boolean(TOKEN),

                    marketTime: istTime()

                });
            }

            if (url.pathname === "/api/status") {

                await loadIndexMaster();

                return sendJson(res, 200, {

                    status: "OK",

                    tokenConfigured:
                        Boolean(TOKEN),

                    masterLoaded,

                    indexes: indexMap,

                    scanner:
                        INDEX_SELL_CONFIG.VERSION

                });
            }

            if (
                url.pathname === "/api/index-sell-scan"
            ) {

                const force =
                    url.searchParams.get("force") === "true";

                const data =
                    await runIndexSellScan(force);

                return sendJson(res, 200, data);
            }

            if (
                url.pathname === "/api/strong-ce-sell"
            ) {

                const data =
                    await runIndexSellScan();

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

            console.error(
                "[INDEX SELL SCANNER]",
                error
            );

            return sendJson(res, 500, {

                status: "ERROR",

                message: error.message

            });
        }
    }
);

// ==============================================
// START SERVER
// ==============================================

server.listen(PORT, () => {

    console.log(
        `SMART MONEY PRO INDEX SELLING RUNNING ON ${PORT}`
    );

});
