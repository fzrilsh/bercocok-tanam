const fs = require("fs");
const path = require("path");
const { getConfig, ROOT_DIR } = require("./config");

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
        fs.writeFileSync(filePath, "");
    }
}

function readLines(filePath) {
    ensureFileExists(filePath);

    const content = fs.readFileSync(filePath, "utf-8").trim();

    return content ? content.split(/\r?\n/) : [];
}

function writeLines(filePath, lines) {
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

async function acquireAccountLock(email, log, progressUpdate) {
    if (activeAccounts.has(email)) {
        log(
            `[Lock] ${email} is currently being processed by another worker. Waiting...`,
        );

        if (progressUpdate) {
            progressUpdate({ step: "⏳ Antri login..." });
        }

        while (activeAccounts.has(email)) {
            await sleep(2000);
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

async function acquireProxy(log, progressUpdate) {
    const proxies = readProxyPool();
    if (proxies.length === 0) {return null;}

    while (true) {
        for (const proxy of proxies) {
            if (!activeProxies.has(proxy)) {
                activeProxies.add(proxy);
                if (log) {log(`[Proxy] Acquired: ${proxy.split(':')[0]}`);}
                return proxy;
            }
        }

        if (log) {log('[Proxy] All proxies in use, waiting...');}
        if (progressUpdate) {progressUpdate({ step: '⏳ Antri proxy...' });}
        await sleep(2000);
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
    if (proxy) {activeProxies.delete(proxy);}
}

async function testProxy(proxy, index, total) {
    const { launchBrowser } = require('./browser');
    const proxyDisplay = proxy.includes('@')
        ? proxy.split('@')[1].split(':')[0]
        : proxy.split('://')[1]?.split(':')[0] || proxy.split(':')[0];

    process.stdout.write(`\rTesting proxy ${index}/${total}: ${proxyDisplay}...`);

    try {
        const { browser, page } = await launchBrowser(0, 0, proxy);

        await page.goto('https://www.google.com', {
            waitUntil: 'domcontentloaded',
            timeout: 15000
        });

        await browser.close();
        process.stdout.write(`\rTesting proxy ${index}/${total}: ${proxyDisplay}... ✅\n`);
        return { proxy, working: true, proxyDisplay };
    } catch (error) {
        process.stdout.write(`\rTesting proxy ${index}/${total}: ${proxyDisplay}... ❌\n`);
        return { proxy, working: false, error: error.message, proxyDisplay };
    }
}

async function testAllProxies() {
    const proxies = readProxyPool();

    if (proxies.length === 0) {
        console.log('\n❌ No proxies found in proxy pool.');
        console.log('   Set PROXY_POOL_FILE in your environment or add proxies to proxy_pool.txt\n');
        return null;
    }

    console.log(`\n🔍 Testing ${proxies.length} proxies...\n`);

    const results = [];
    for (let i = 0; i < proxies.length; i++) {
        const result = await testProxy(proxies[i], i + 1, proxies.length);
        results.push(result);
    }

    const working = results.filter(r => r.working);
    const failed = results.filter(r => !r.working);

    console.log('\n' + '═'.repeat(60));
    console.log(`✅ Working proxies: ${working.length}/${proxies.length}`);
    console.log(`❌ Failed proxies: ${failed.length}/${proxies.length}`);
    console.log('═'.repeat(60));

    if (working.length > 0) {
        console.log('\n📋 Working proxies:');
        working.forEach((r, i) => {
            console.log(`   ${(i + 1).toString().padStart(2)}. ${r.proxyDisplay}`);
        });
    }

    if (failed.length > 0) {
        console.log('\n❌ Failed proxies:');
        failed.forEach((r, i) => {
            const errorMsg = r.error.includes('ERR_')
                ? r.error.split('net::')[1]?.split(' ')[0] || r.error.substring(0, 30)
                : r.error.substring(0, 30);
            console.log(`   ${(i + 1).toString().padStart(2)}. ${r.proxyDisplay} - ${errorMsg}`);
        });
    }

    console.log('');

    return { working, failed, total: proxies.length };
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
    testAllProxies,
};
