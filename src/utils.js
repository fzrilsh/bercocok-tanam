const fs = require("fs");
const path = require("path");
const { getConfig, ROOT_DIR } = require("./config");

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

function randomUA() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
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
};
