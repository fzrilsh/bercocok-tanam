const fs = require("fs");
const { getConfig, getResultFile, SHARED_SELECTORS } = require("./config");
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
    ensureFileExists,
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

const TARGET_URL = "https://aerolink.lat/register?ref=AIBB-XQ";
const QUEUE_RETRY_DELAY_MS = 500;

async function openAerolinkSignIn(page, log) {
    const config = getConfig();

    log(`Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log("Waiting for Cloudflare challenge to pass...");
    try {
        await page.waitForFunction(
            () => !document.querySelector('#challenge-error-text') && !document.querySelector('.cf-turnstile-wrapper') && !document.querySelector('#turnstile-wrapper'),
            { timeout: config.timeouts.navigation }
        );
        log("Cloudflare challenge cleared.");
    } catch (_) {
        log("No Cloudflare challenge detected or timeout waiting for it to clear.");
    }

    // Wait an extra moment for the React/Vue app to mount the login buttons
    await sleep(2000);

    log("Clicking Google login button...");

    // Try catching it via specific text content
    await clickSelector(page, "::-p-text(Sign up with Google)", {
        timeout: 30000,
        visible: true
    });
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

    log("Waiting for Aerolink dashboard...");

    await page.waitForFunction(
        () => {
            const url = window.location.href;

            return (
                url.includes("aerolink.lat") &&
                url.includes("/dashboard")
            );
        },
        { timeout: config.timeouts.navigation },
    );

    log("Redirected to Aerolink dashboard!");
}

async function getAerolinkSession(page, log) {
    const config = getConfig();
    await sleep(config.delays.beforeReadingCookies);

    const cookies = await page.cookies(page.url());
    const cookieHeader = cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");

    if (!cookieHeader) {
        throw new Error("Aerolink cookies not found");
    }

    log(`Got ${cookies.length} Aerolink cookies`);
    return { cookieHeader };
}

function saveCookieHeader(email, cookieHeader, log) {
    const resultFile = getResultFile("aerolink_cookies");
    ensureFileExists(resultFile);
    fs.appendFileSync(resultFile, `${email}|${cookieHeader}\n`);
    log(`Full cookie header saved to ${resultFile}`);
}

async function processAerolinkAccount(
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
    log(`Launching browser`);

    const { browser, page } = await launchBrowser(browserArgsIndex, workerIndex, proxy);

    try {
        updateProgress({ step: STEPS.NAVIGATING });
        await openAerolinkSignIn(page, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        await completeGoogleLogin(page, account, log);
        await handlePostLogin(page, log);

        updateProgress({ step: STEPS.WAITING });
        await waitForDashboard(page, log);

        updateProgress({ step: STEPS.GETTING_TOKEN });
        const { cookieHeader } = await getAerolinkSession(page, log);

        saveCookieHeader(account.email, cookieHeader, log);

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

async function runAerolinkWorker(
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

            await processAerolinkAccount(
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

            appendErrorAccount(account, error.message, "Aerolink");
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
        label: `Aerolink W${workerIndex + 1}`,
    };
}

async function runAerolinkAutomation(sharedProgress = null, useProxy = true) {
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
            `🚀 Aerolink Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`aerolink-${i}`, chunk.length, `Aerolink W${i + 1}`);
    });

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;
            return runAerolinkWorker(
                chunk,
                `aerolink-${i}`,
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
        printReport("🚀 AEROLINK AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `Aerolink finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();
    return { successCount, failedCount, results };
}

module.exports = {
    runAerolinkAutomation,
};