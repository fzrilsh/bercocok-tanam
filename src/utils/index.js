const fs = require("fs");
const path = require("path");
const { getConfig, ROOT_DIR } = require("../config");

const USER_AGENTS = [
    // Chrome Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; WOW64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",

    // Chrome macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",

    // Chrome Linux
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",

    // Firefox Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",

    // Firefox macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13.7; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13.7; rv:132.0) Gecko/20100101 Firefox/132.0",

    // Firefox Linux
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (X11; Fedora; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",

    // Edge Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",

    // Edge macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",

    // Safari macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",

    // Opera Windows
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/116.0.0.0",
    "Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0",

    // Opera macOS
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0",

    // Opera Linux
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 OPR/117.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/116.0.0.0",
];

let uaPool = [];

function randomUA() {
  if (uaPool.length === 0) {
    uaPool = [...USER_AGENTS].sort(() => Math.random() - 0.5);
  }

  return uaPool.pop();
}

const sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

function formatDuration(milliseconds) {
    const totalSeconds = Math.round(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const decimalMinutes = (milliseconds / 60000).toFixed(2);

    return `${decimalMinutes} min (${minutes}m ${seconds}s)`;
}

function ensureFileExists(filePath) {
    if (!fs.existsSync(filePath)) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, "");
    }
}

function readLines(filePath) {
    ensureFileExists(filePath);

    const content = fs.readFileSync(filePath, "utf-8").trim();

    return content ? content.split(/\r?\n/) : [];
}

function writeLines(filePath, lines) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, lines.join("\n"));
}

function readAccounts() {
    const config = getConfig();
    const allLines = readLines(config.accountFile);
    const validAccounts = [];
    const invalidLines = [];

    allLines
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .forEach((rawLine) => {
            const parts = rawLine.split("|");

            if (parts.length < 2) {
                invalidLines.push({ line: rawLine, reason: "Wrong format - should be: email|password or email|password|proxy" });
                return;
            }

            const email = parts[0]?.trim();
            const password = parts[1]?.trim();

            if (!email || !password) {
                invalidLines.push({ line: rawLine, reason: "Email or password is empty" });
                return;
            }

            const acc = {
                email,
                password,
                rawLine,
            };

            if (parts.length >= 3 && parts[2]?.trim()) {
                acc.proxy = parts[2].trim();
            }

            validAccounts.push(acc);
        });

    if (invalidLines.length > 0 && validAccounts.length === 0) {
        console.error("");
        console.error("❌ ERROR: All accounts in accounts.txt have wrong format!");
        console.error("");
        console.error("Correct format:");
        console.error("  email|password");
        console.error("  email|password|proxy");
        console.error("");
        console.error("Examples:");
        console.error("  user@gmail.com|MyPassword123");
        console.error("  user@gmail.com|MyPassword123|http://proxy:8080");
        console.error("");
        console.error("Invalid lines:");
        invalidLines.slice(0, 5).forEach((item) => {
            console.error(`  - ${item.line}`);
            console.error(`    ${item.reason}`);
        });
        if (invalidLines.length > 5) {
            console.error(`  ... and ${invalidLines.length - 5} more lines`);
        }
        console.error("");
    }

    return validAccounts;
}

function removeAccount(rawLine) {
    const config = getConfig();
    const remainingLines = readLines(config.accountFile).filter(
        (line) => line.trim() !== rawLine,
    );

    writeLines(config.accountFile, remainingLines);
}

function appendErrorAccount(account, errorMessage, automationType = "Unknown") {
    const config = getConfig();

    ensureFileExists(config.errorAccountFile);

    const timestamp = new Date().toISOString();

    fs.appendFileSync(
        config.errorAccountFile,
        `${account.rawLine} | ${automationType} | ${timestamp} | ${errorMessage}\n`,
    );
}

function chunkAccounts(accounts, count) {
    const chunks = Array.from({ length: count }, () => []);

    accounts.forEach((account, i) => chunks[i % count].push(account));

    return chunks.filter((chunk) => chunk.length > 0);
}

function createFileLogger() {
    const logDir = path.join(ROOT_DIR, "logs");

    if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = path.join(logDir, `${timestamp}.log`);
    const stream = fs.createWriteStream(logFile, { flags: "a" });

    function log(message) {
        const ts = new Date().toISOString();
        stream.write(`[${ts}] ${message}\n`);
    }

    function close() {
        stream.end();
    }

    return { log, close, logFile };
}

const activeAccounts = new Set();
const activeProxies = new Set();
const proxyLastUsed = new Map(); // IP:port -> last used timestamp
const PROXY_COOLDOWN_MS = 60 * 1000; // 60s cooldown after release
const ACCOUNT_LOCK_POLL_MS = 2000; // Check every 2 seconds if account lock is released
const PROXY_POOL_POLL_MS = 2000; // Check every 2 seconds if proxy becomes available
const PROXY_WAIT_BUFFER_MS = 1000; // Extra buffer when waiting for proxy cooldown
const PROXY_WAIT_MAX_MS = 5000; // Maximum wait time per iteration when proxies cooling down

async function acquireAccountLock(email, log, progressUpdate) {
    if (activeAccounts.has(email)) {
        log(
            `[Lock] ${email} is currently being processed by another worker. Waiting...`,
        );

        if (progressUpdate) {
            progressUpdate({ step: "⏳ Antri login..." });
        }

        while (activeAccounts.has(email)) {
            await sleep(ACCOUNT_LOCK_POLL_MS);
        }
    }

    activeAccounts.add(email);
}

function tryAcquireAccountLock(email) {
    if (activeAccounts.has(email)) {return false;}

    activeAccounts.add(email);

    return true;
}

function releaseAccountLock(email) {
    activeAccounts.delete(email);
}

function readProxyPool() {
    const config = getConfig();
    if (!config.proxyPoolFile) {return [];}

    const lines = readLines(config.proxyPoolFile);
    return lines
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"))
        .map(line => {
            // Convert host:port:user:pass to http://user:pass@host:port
            const parts = line.split(':');
            if (parts.length >= 4 && !line.includes('://')) {
                const host = parts[0];
                const port = parts[1];
                const user = parts[2];
                const pass = parts.slice(3).join(':'); // Handle pass with colons
                return `http://${user}:${pass}@${host}:${port}`;
            }
            return line; // Already in URL format
        });
}

function getProxyIP(proxy) {
    // Extract IP:port from proxy string (base cooldown on IP, not credentials)
    // Format: http://user:pass@ip:port -> ip:port
    if (proxy.includes('@')) {
        return proxy.split('@')[1];
    }
    // Format: http://ip:port -> ip:port
    if (proxy.includes('://')) {
        return proxy.split('://')[1];
    }
    // Fallback: ip:port...
    return proxy.split(':').slice(0, 2).join(':');
}

async function acquireProxy(log, progressUpdate) {
    const proxies = readProxyPool();
    if (proxies.length === 0) {return null;}

    while (true) {
        let earliestAvailable = Infinity;

        for (const proxy of proxies) {
            const proxyIP = getProxyIP(proxy);
            const lastUsed = proxyLastUsed.get(proxyIP) || 0;
            const timeSinceUse = Date.now() - lastUsed;
            const cooldownRemaining = PROXY_COOLDOWN_MS - timeSinceUse;

            // Check if proxy available (not in use AND past cooldown)
            if (!activeProxies.has(proxy) && cooldownRemaining <= 0) {
                activeProxies.add(proxy);
                if (log) {log(`[Proxy] Acquired: ${proxyIP.split(':')[0]}`);}
                return proxy;
            }

            // Track earliest available proxy
            if (cooldownRemaining > 0 && cooldownRemaining < earliestAvailable) {
                earliestAvailable = cooldownRemaining;
            }
        }

        // All proxies in use or cooldown
        if (earliestAvailable < Infinity) {
            const waitSec = Math.ceil(earliestAvailable / 1000);
            if (log) {log(`[Proxy] All in cooldown, next available in ${waitSec}s`);}
            if (progressUpdate) {progressUpdate({ step: `⏳ Proxy cooldown ${waitSec}s` });}
            await sleep(Math.min(earliestAvailable + PROXY_WAIT_BUFFER_MS, PROXY_WAIT_MAX_MS));
        } else {
            if (log) {log('[Proxy] All proxies in use, waiting...');}
            if (progressUpdate) {progressUpdate({ step: '⏳ Antri proxy...' });}
            await sleep(PROXY_POOL_POLL_MS);
        }
    }
}

function tryAcquireProxy() {
    const proxies = readProxyPool();
    if (proxies.length === 0) {return null;}

    for (const proxy of proxies) {
        if (!activeProxies.has(proxy)) {
            activeProxies.add(proxy);
            return proxy;
        }
    }

    return null;
}

function releaseProxy(proxy) {
    if (proxy) {
        activeProxies.delete(proxy);
        proxyLastUsed.set(getProxyIP(proxy), Date.now());
    }
}

module.exports = {
    randomUA,
    sleep,
    formatDuration,
    ensureFileExists,
    readLines,
    writeLines,
    readAccounts,
    removeAccount,
    appendErrorAccount,
    chunkAccounts,
    createFileLogger,
    acquireAccountLock,
    tryAcquireAccountLock,
    releaseAccountLock,
    readProxyPool,
    acquireProxy,
    tryAcquireProxy,
    releaseProxy,
};
