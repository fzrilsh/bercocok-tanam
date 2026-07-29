const { getConfig, SHARED_SELECTORS } = require("../../config");
const {
    sleep,
    readAccounts,
    chunkAccounts,
    createFileLogger,
    formatDuration,
} = require("../../utils");
const { clickSelector, clickFirstVisibleSelector } = require("../../browser/helpers");
const { STEPS, createProgressManager } = require("../../cli/progress");
const { printReport } = require("../../cli/reporter");
const KiroWorker = require("./KiroWorker");

const TARGET_URL = "https://app.kiro.dev/signin/";

async function openKiroSignIn(page, log) {
    const config = getConfig();

    log(`Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log("Clicking Google login button...");
    await clickSelector(page, SHARED_SELECTORS.googleSignIn);
}

async function handlePostLogin(page, log) {
    const config = getConfig();

    try {
        log("Clicking I Understand...");
        await clickSelector(page, SHARED_SELECTORS.iUnderstand, {
            timeout: config.timeouts.short,
            delayBeforeClick: config.delays.beforeNextClick,
        });
    } catch (_) {
        log("No I Understand button found");
    }

    try {
        log("Clicking Login/Allow/Continue...");

        // Scroll to bottom to ensure button is in viewport for headless mode
        // Puppeteer clicks fail silently on off-screen elements in headless
        await page.keyboard.press('End');

        await clickFirstVisibleSelector(
            page,
            SHARED_SELECTORS.loginOptions,
            config.timeouts.short,
        );
    } catch (_) {
        log("No Login button found");
    }
}

async function waitForDashboard(page, log) {
    const config = getConfig();

    log("Waiting for Kiro dashboard...");

    await page.waitForFunction(
        () => {
            const url = window.location.href;

            return (
                url.includes("app.kiro.dev") &&
                url.includes("/home")
            );
        },
        { timeout: config.timeouts.navigation },
    );

    log("Redirected to Kiro dashboard!");
}

async function getRefreshToken(page, log) {
    const config = getConfig();

    await sleep(config.delays.beforeReadingCookies);

    const refreshToken = (await page.cookies()).find(
        (cookie) => cookie.name === "RefreshToken",
    );

    if (!refreshToken?.value) {
        throw new Error("RefreshToken cookie not found");
    }

    log(`Got RefreshToken (${refreshToken.value.slice(0, 20)}...)`);

    return refreshToken.value;
}


async function runKiroAutomation(sharedProgress = null, useProxy = true) {
    const config = getConfig();
    const logger = createFileLogger();
    const accounts = readAccounts();

    if (accounts.length === 0) {
        if (!sharedProgress) { console.log("No accounts found. Format: email|password"); }
        logger.close();

        return null;
    }

    const startedAt = Date.now();
    const chunks = chunkAccounts(accounts, config.browserCount);

    const progress =
        sharedProgress ||
        createProgressManager(
            `🌱 Kiro Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`kiro-${i}`, chunk.length, `Kiro W${i + 1}`);
    });

    const worker = new KiroWorker(
        openKiroSignIn,
        handlePostLogin,
        waitForDashboard,
        getRefreshToken,
    );

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return worker.run(
                chunk,
                `kiro-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
                useProxy,
            );
        }),
    );

    if (!sharedProgress) {
        progress.stop();
    }

    const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
    const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("🌱 KIRO AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `Kiro finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runKiroAutomation,
};
