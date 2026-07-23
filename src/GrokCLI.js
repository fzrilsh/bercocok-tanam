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
const { launchBrowser, waitForNewPage } = require("./browser");
const {
    completeGoogleLogin,
    clickFirstVisibleSelector,
    GOOGLE_SELECTORS,
} = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const QUEUE_RETRY_DELAY_MS = 500;
const XAI_GOOGLE_SELECTORS = [
    "button::-p-text(Login with Google)",
    "button::-p-text(Continue with Google)",
    "button::-p-text(Sign in with Google)",
    "a::-p-text(Continue with Google)",
    "button::-p-text(Google)",
    "a::-p-text(Google)",
];

function getGrokCLIUrl() {
    const base = getConfig().routerUrl.replace(/\/$/, "");
    return `${base}/dashboard/providers/grok-cli`;
}

function isGoogleAuthUrl(url) {
    return /accounts\.google\.com|google\.com\/signin|google\.com\/oauth/i.test(url || "");
}

function isTransientNavError(err) {
    return /detached|Target closed|Session closed|Execution context was destroyed|frame was detached/i
        .test(err?.message || String(err || ""));
}

async function waitForXaiGoogleReady(page, log, timeout) {
    const start = Date.now();
    let clickedContinue = false;

    while (Date.now() - start < timeout) {
        try {
            if (page.isClosed?.()) {
                throw new Error("xAI popup closed before Google auth");
            }

            const url = page.url();
            if (isGoogleAuthUrl(url)) {
                log("Already on Google auth");
                return "google";
            }

            if (await page.$(GOOGLE_SELECTORS.accountChooser)) {
                log("Google account chooser already open");
                return "chooser";
            }

            for (const sel of XAI_GOOGLE_SELECTORS) {
                const el = await page.$(sel);
                if (!el) {continue;}
                const visible = await el.boundingBox().catch(() => null);
                if (!visible) {continue;}
                log(`Clicking Google login (${sel})...`);
                await el.click();
                return "clicked";
            }

            // Device / intermediate Continue — only once, and only if no Google button yet
            if (!clickedContinue) {
                const cont = await page.$("button::-p-text(Continue)");
                if (cont) {
                    const visible = await cont.boundingBox().catch(() => null);
                    if (visible) {
                        log("Clicking Continue on device/intermediate page...");
                        await cont.click();
                        clickedContinue = true;
                    }
                }
            }
        } catch (err) {
            if (!isTransientNavError(err)) {throw err;}
            log(`Transient nav error (retrying): ${err.message}`);
        }

        await sleep(250);
    }

    throw new Error("xAI auth not ready: no Google button / redirect within timeout");
}

async function open9RouterSignIn(browser, page, log) {
    const config = getConfig();
    const targetUrl = getGrokCLIUrl();

    log(`Navigating to ${targetUrl}`);
    await page.goto(targetUrl, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log("Clicking Add...");
    log("Waiting for xAI popup tab...");
    const newTab = await waitForNewPage(
        browser,
        () => clickFirstVisibleSelector(page, ["button.bg-brand-500::-p-text(Add)"]),
        config.timeouts.navigation,
    );

    await newTab.bringToFront();
    await newTab.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});

    log("Waiting for Google login button or Google redirect...");
    await waitForXaiGoogleReady(newTab, log, config.timeouts.navigation);

    // After click, wait until Google surface (or chooser) actually shows
    const started = Date.now();
    while (Date.now() - started < config.timeouts.default) {
        try {
            if (isGoogleAuthUrl(newTab.url())) {break;}
            if (await newTab.$(GOOGLE_SELECTORS.accountChooser)) {break;}
            if (await newTab.$(GOOGLE_SELECTORS.emailInput)) {break;}
        } catch (err) {
            if (!isTransientNavError(err)) {throw err;}
        }
        await sleep(250);
    }

    return newTab;
}

async function handlePostLogin(page, log) {
    const config = getConfig();

    // Optional: click if present, skip if not
    try {
        const iUnderstand = await Promise.race(
            SHARED_SELECTORS.iUnderstand.map((sel) =>
                page.waitForSelector(sel, { visible: true, timeout: config.timeouts.short }).then(() => sel),
            ),
        );
        log("Clicking I Understand...");
        await sleep(config.delays.beforeNextClick);
        await page.click(iUnderstand);
    } catch (_) {
        log("No I Understand button found, skipping...");
    }

    log("Waiting for Grok redirect...");

    try {
        log("Clicking Continue...");
        await clickFirstVisibleSelector(
            page,
            ["button::-p-text(Continue)"],
            config.timeouts.short,
        );
        await sleep(1000);
    } catch (_) {
        log("No Continue button found");
    }

    try {
        log("Clicking Allow...");
        // Scroll bottom — headless click fails silently on off-screen elements
        await page.keyboard.press("End");
        await sleep(500);
        await clickFirstVisibleSelector(
            page,
            [
                "button::-p-text(Allow)",
                "::-p-text(Allow)",
                ...SHARED_SELECTORS.loginOptions,
            ],
            config.timeouts.default,
        );
    } catch (_) {
        log("No Allow button found");
    }
}

async function grabGrokCookies(page, log, email) {
    const config = getConfig();

    log("Navigating to grok.com...");
    await page.goto("https://grok.com", {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    await sleep(config.delays.beforeReadingCookies);

    const cookies = await page.cookies();
    const cookieHeader = cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join("; ");

    if (!cookieHeader) {
        throw new Error("Grok cookies not found");
    }

    log(`Got ${cookies.length} Grok cookies`);

    const resultDir = require("path").join(require("./config").ROOT_DIR, "grok_keys");
    if (!fs.existsSync(resultDir)) {
        fs.mkdirSync(resultDir, { recursive: true });
    }

    const resultFile = require("path").join(resultDir, "grok_keys.txt");
    ensureFileExists(resultFile);
    fs.appendFileSync(resultFile, `${email}|${cookieHeader}\n`);
    log(`Cookies saved to ${resultFile}`);
}

async function processGrokCLIOnBrowser(account, ctx) {
    const { browser, page, log, updateProgress } = ctx;

    updateProgress({ step: STEPS.NAVIGATING, email: account.email });
    const popupPage = await open9RouterSignIn(browser, page, log);

    updateProgress({ step: STEPS.GOOGLE_LOGIN });
    await completeGoogleLogin(popupPage, account, log);
    await handlePostLogin(popupPage, log);

    updateProgress({ step: STEPS.WAITING });
    log("Waiting for xAI authorization to finalize...");
    await sleep(3000);

    updateProgress({ step: STEPS.GETTING_TOKEN });
    await grabGrokCookies(popupPage, log, account.email);
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
    log("Launching browser");

    const { browser, page } = await launchBrowser(browserArgsIndex, workerIndex, proxy);

    try {
        await processGrokCLIOnBrowser(account, { browser, page, proxy, log, updateProgress });

        removeAccount(account.rawLine);
        log(`Account login successful! Removed from accounts file: ${account.email}`);

        await sleep(config.delays.beforeBrowserClose);
    } finally {
        await browser.close();
        log("Browser closed.");
        if (poolProxy) {
            releaseProxy(poolProxy);
            log(`[Proxy] Released: ${poolProxy.split(":")[0]}`);
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

            if (hasLock) {releaseAccountLock(account.email);}
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
        if (!sharedProgress) {console.log("No accounts found. Format: email|password");}
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

    if (!sharedProgress) {progress.stop();}

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
    processGrokCLIOnBrowser,
    grabGrokCookies,
};
