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

function saveRefreshToken(email, refreshToken, log) {
    const resultFile = getResultFile("kiro");

    ensureFileExists(resultFile);

    fs.appendFileSync(
        resultFile,
        `${email}|${refreshToken}\n`,
    );

    log(`Refresh token saved to ${resultFile}`);
}

async function importRefreshToken(refreshToken, log) {
    const config = getConfig();
    const baseUrl = config.routerUrl.replace(/\/$/, "");
    const apiUrl = `${baseUrl}/api/oauth/kiro/import`;

    log(`Importing refresh token to ${apiUrl}...`);

    const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
        },
        body: JSON.stringify({ refreshToken }),
    });

    const text = await response.text();
    let data;

    try {
        data = JSON.parse(text);
    } catch (_) {
        throw new Error(`Invalid JSON response: ${text.substring(0, 100)}`);
    }

    if (!response.ok) {
        throw new Error(
            `API Error ${response.status}: ${data.error || JSON.stringify(data)}`,
        );
    }

    log("Successfully imported token!");
}

async function processKiroAccount(
    account,
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
) {
    const config = getConfig();
    let poolProxy = null;
    let proxy = account.proxy || null;

    if (!proxy && config.proxyPoolFile) {
        poolProxy = await acquireProxy(log, updateProgress);
        proxy = poolProxy;
    }

    updateProgress({ step: STEPS.LAUNCHING, email: account.email });
    log(`Launching browser for ${account.email}`);

    const { browser, page } = await launchBrowser(
        browserArgsIndex,
        workerIndex,
        proxy,
    );

    try {
        updateProgress({ step: STEPS.NAVIGATING });
        await openKiroSignIn(page, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        await completeGoogleLogin(page, account, log);
        await handlePostLogin(page, log);

        updateProgress({ step: STEPS.WAITING });
        await waitForDashboard(page, log);

        updateProgress({ step: STEPS.GETTING_TOKEN });
        const refreshToken = await getRefreshToken(page, log);
        saveRefreshToken(account.email, refreshToken, log);

        updateProgress({ step: STEPS.IMPORTING });
        await importRefreshToken(refreshToken, log);

        removeAccount(account.rawLine);
        log(
            `Account login successful! Removed from accounts file: ${account.email}`,
        );

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

async function runKiroWorker(
    workerAccounts,
    workerId,
    browserArgsIndex,
    workerIndex,
    total,
    progress,
    log,
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
                log(
                    `[${workerId}] ${account.email} is locked, moving to back of queue.`,
                );
                queue.push(queue.shift());
                await sleep(500);
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

            await processKiroAccount(
                account,
                browserArgsIndex,
                workerIndex,
                log,
                updateProgress,
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

            appendErrorAccount(account, error.message, "Kiro");
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

            if (hasLock) {
                releaseAccountLock(account.email);
            }
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
        label: `Kiro W${workerIndex + 1}`,
    };
}

async function runKiroAutomation(sharedProgress = null) {
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

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return runKiroWorker(
                chunk,
                `kiro-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
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
