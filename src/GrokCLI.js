const fs = require("fs");
const { getConfig, SHARED_SELECTORS } = require("./config");
const {
    sleep,
    readAccounts,
    removeAccount,
    appendErrorAccount,
    chunkAccounts,
    createFileLogger,
    formatDuration,
    acquireAccountLock,
    releaseAccountLock,
    tryAcquireAccountLock,
    acquireProxy,
    releaseProxy,
} = require("./utils");
const { launchBrowser } = require("./browser");
const {
    completeGoogleLogin,
    clickSelector,
    clickFirstVisibleSelector,
} = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const TARGET_URL = 'https://fzrilsh-9router-production.up.railway.app/dashboard/providers/grok-cli';
const QUEUE_RETRY_DELAY_MS = 500;

async function open9RouterSignIn(browser, page, log) {
    const config = getConfig();

    log(`Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log("Clicking Add...");
    await clickFirstVisibleSelector(page, ["button.bg-brand-500::-p-text(Add)"]);

    log("Waiting for xAI popup tab...");
    await sleep(2000);

    const pages = await browser.pages();
    const newTab = pages[pages.length - 1];

    if (newTab === page) {
        throw new Error("Popup tab did not open");
    }

    await newTab.bringToFront();

    // Now we are at the Device Code screen (e.g. grok.com/device)
    log("Clicking Continue on Device Code page...");
    await clickFirstVisibleSelector(newTab, ["button::-p-text(Continue)"]);
    await sleep(1000);

    // Now we are at the Login Options screen
    log("Clicking Login with Google on xAI...");
    await clickFirstVisibleSelector(newTab, ["button::-p-text(Login with Google)"]);
    await sleep(1000);

    return newTab;
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

    log("Waiting for Grok redirect...");

    try {
        log("Clicking Continue...");
        await clickFirstVisibleSelector(
            page,
            ["button::-p-text(Continue)"],
            config.timeouts.short
        );
        await sleep(1000);
    } catch (_) {
        log("No Continue button found");
    }

    try {
        log("Clicking Allow...");
        await page.keyboard.press('End');
        await clickFirstVisibleSelector(
            page,
            ["button::-p-text(Allow)"],
            config.timeouts.short
        );
    } catch (_) {
        log("No Allow button found");
    }
}

async function processGrokCLIAccount(
    account,
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
    useProxy = true,
) {
    const config = getConfig();
    let poolProxy = null;
    let proxy = account.proxy || null;

    if (!proxy && config.proxyPoolFile && useProxy) {
        poolProxy = await acquireProxy(log, updateProgress);
        proxy = poolProxy;
    }

    updateProgress({ step: STEPS.LAUNCHING, email: account.email });
    log(`Launching browser for ${account.email}`);

    // Pass false to match old behavior where headless was forced off,
    // or let it use config.headless if you prefer. Leaving as config.headless to match standard project behavior.
    const { browser, page } = await launchBrowser(browserArgsIndex, workerIndex, proxy);
    let popupPage = null;

    try {
        updateProgress({ step: STEPS.NAVIGATING });
        popupPage = await open9RouterSignIn(browser, page, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        await completeGoogleLogin(popupPage, account, log);
        await handlePostLogin(popupPage, log);

        updateProgress({ step: STEPS.WAITING });

        // Wait a bit to ensure the login request processes and the popup closes automatically
        log("Waiting for xAI authorization to finalize...");
        await sleep(3000);

        removeAccount(account.rawLine);
        log(`Account login successful! Removed from accounts file: ${account.email}`);

        await sleep(config.delays.beforeBrowserClose);
    } finally {
        await browser.close();
        log("Browser closed.");
        if (poolProxy) {
            releaseProxy(poolProxy);
            log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
        }
    }
}

async function runGrokCLIWorker(
    workerAccounts,
    workerId,
    browserArgsIndex,
    workerIndex,
    total,
    progress,
    log,
    useProxy = true,
) {
    const config = getConfig();
    let successCount = 0;
    let failedCount = 0;
    let processedCount = 0;

    const accountStats = [];
    const queue = [...workerAccounts];

    while (queue.length > 0) {
        const account = queue[0];
        let hasLock = false;

        if (queue.length > 1) {
            if (!tryAcquireAccountLock(account.email)) {
                log(`[${workerId}] ${account.email} is locked, moving to back of queue.`);
                queue.push(queue.shift());
                await sleep(QUEUE_RETRY_DELAY_MS);
                continue;
            }
            hasLock = true;
        }

        const updateProgress = (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };

        const startTime = Date.now();
        let accountSuccess = false;
        let accountError = null;

        try {
            if (!hasLock) {
                await acquireAccountLock(account.email, log, updateProgress);
                hasLock = true;
            }
            queue.shift();

            await processGrokCLIAccount(
                account,
                browserArgsIndex,
                workerIndex,
                log,
                updateProgress,
                useProxy,
            );

            accountSuccess = true;
            successCount += 1;
            processedCount += 1;

            progress.updateWorker(workerId, {
                step: STEPS.DONE,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } catch (error) {
            accountSuccess = false;
            accountError = error.message;
            failedCount += 1;
            processedCount += 1;

            appendErrorAccount(account, error.message, "GrokCLI");
            browserArgsIndex = (browserArgsIndex + 1) % config.browserArgsSets.length;

            log(`[${workerId}] Error: ${error.message}`);
            progress.updateWorker(workerId, {
                step: STEPS.ERROR,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        } finally {
            const duration = Date.now() - startTime;
            accountStats.push({
                email: account.email,
                rawLine: account.rawLine,
                success: accountSuccess,
                duration,
                error: accountError,
            });

            if (hasLock) releaseAccountLock(account.email);
        }

        if (queue.length > 0) {
            progress.updateWorker(workerId, { step: STEPS.WAITING });
            await sleep(config.delays.betweenAccounts);
        }
    }

    progress.updateWorker(workerId, {
        step: STEPS.DONE,
        email: "Done",
        success: successCount,
        failed: failedCount,
        current: workerAccounts.length,
    });

    return {
        successCount,
        failedCount,
        accounts: accountStats,
        label: `GrokCLI W${workerIndex + 1}`,
    };
}

async function runGrokCLIAutomation(sharedProgress = null, useProxy = true) {
    const config = getConfig();
    const logger = createFileLogger();
    const accounts = readAccounts();

    if (accounts.length === 0) {
        if (!sharedProgress) console.log("No accounts found. Format: email|password");
        logger.close();
        return null;
    }

    const startedAt = Date.now();
    const chunks = chunkAccounts(accounts, config.browserCount);
    const progress =
        sharedProgress ||
        createProgressManager(
            `🚀 GrokCLI Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`grokCLI-${i}`, chunk.length, `GrokCLI W${i + 1}`);
    });

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;
            return runGrokCLIWorker(
                chunk,
                `grokCLI-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
                useProxy,
            );
        }),
    );

    if (!sharedProgress) progress.stop();

    const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
    const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("🚀 GROK_CLI AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `GrokCLI finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();
    return { successCount, failedCount, results };
}

module.exports = {
    runGrokCLIAutomation,
};