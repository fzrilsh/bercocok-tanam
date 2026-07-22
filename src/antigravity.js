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

const TARGET_URL = 'https://fzrilsh-9router-production.up.railway.app/';
const QUEUE_RETRY_DELAY_MS = 500;

const PROVIDER_SELECTOR =
  'body > div.flex.h-screen.w-full.overflow-hidden.bg-bg > div.hidden.lg\\:flex > aside > nav > a:nth-child(2)';

const ANTIGRAVITY_SELECTOR =
  'body > div.flex.h-screen.w-full.overflow-hidden.bg-bg > main > div.flex-1.overflow-y-auto.custom-scrollbar.p-6.lg\\:p-10 > div > div > div:nth-child(2) > div.grid.grid-cols-1.gap-3.sm\\:grid-cols-2.sm\\:gap-4.lg\\:grid-cols-3.xl\\:grid-cols-4 > a:nth-child(2) > div > div > div.flex.min-w-0.items-center.gap-3 > div.min-w-0 > h3';

const ADD_SELECTOR =
  'body > div.flex.h-screen.w-full.overflow-hidden.bg-bg > main > div.flex-1.overflow-y-auto.custom-scrollbar.p-6.lg\\:p-10 > div > div > div:nth-child(3) > div.mt-4.grid.grid-cols-1.gap-2.sm\\:flex > button';

const CONFIRM_SELECTOR =
  'body > div.flex.h-screen.w-full.overflow-hidden.bg-bg > main > div.flex-1.overflow-y-auto.custom-scrollbar.p-6.lg\\:p-10 > div > div > div.fixed.inset-0.z-50.flex.items-center.justify-center.p-4 > div.relative.w-full.bg-surface.border.border-border-subtle.rounded-\\[14px\\].shadow-\\[var\\(--shadow-elev\\)\\].fade-in.max-w-sm > div.flex.items-center.justify-end.gap-3.p-6.border-t.border-border-subtle > button.inline-flex.items-center.justify-center.gap-2.font-semibold.transition-all.duration-150.ease-out.cursor-pointer.active\\:scale-\\[0\\.97\\].disabled\\:opacity-50.disabled\\:cursor-not-allowed.disabled\\:active\\:scale-100.bg-red-500.hover\\:bg-red-600.text-white.shadow-sm.disabled\\:bg-surface-3.disabled\\:text-text-muted.h-9.px-4.text-sm.rounded-\\[10px\\]';

async function open9RouterSignIn(browser, page, log) {
    const config = getConfig();

    log(`Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log("Clicking Provider...");
    await clickSelector(page, PROVIDER_SELECTOR, { timeout: 10000 });

    log("Clicking Antigravity...");
    await clickSelector(page, ANTIGRAVITY_SELECTOR, { timeout: 10000 });

    log("Clicking Add...");
    await clickSelector(page, ADD_SELECTOR, { timeout: 10000 });

    log("Clicking Confirm (I Understand, Continue)...");
    await clickSelector(page, CONFIRM_SELECTOR, { timeout: 10000 });

    log("Waiting for new Google Login popup tab...");
    await sleep(5000);

    const pages = await browser.pages();
    const newTab = pages[pages.length - 1];

    if (newTab === page) {
        throw new Error("Popup tab did not open");
    }

    await newTab.bringToFront();
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

    try {
        log("Clicking Login/Allow/Continue/Sign In...");
        await page.keyboard.press('End');
        await clickFirstVisibleSelector(
            page,
            [
                ...SHARED_SELECTORS.loginOptions,
                "#submit_approve_access > div > button",
                "::-p-text(Sign in)"
            ],
            config.timeouts.short,
        );
    } catch (_) {
        log("No Login button found");
    }
}

async function processAntigravityAccount(
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

        // Wait a bit to ensure the login request processes and the popup redirects
        log("Waiting for login to finalize...");
        await sleep(5000);

        // Retrieve the callback URL from the popup tab and paste it into the original tab
        log("Getting callback URL from popup...");
        const callbackUrl = popupPage.url();

        log("Pasting callback URL to main page...");
        await page.bringToFront();

        // Wait for the input field to be ready (targeting the second input inside the modal)
        await page.waitForSelector('input[type="text"]:nth-of-type(1)', { timeout: 10000 });

        // Let's find the correct input field. It's usually the one that is empty or specifically for the callback
        const inputs = await page.$$('input[type="text"]');
        if (inputs.length >= 2) {
            // Type into the second input which is for the callback URL
            await inputs[1].type(callbackUrl);
        } else {
            // Fallback just in case
            await page.keyboard.press('Tab');
            await page.keyboard.type(callbackUrl);
        }

        log("Clicking Connect...");
        // Click the Connect button (the primary button in the dialog)
        const connectButton = await page.$('button.bg-primary');
        if (connectButton) {
            await connectButton.click();
        } else {
            // Fallback: look for button with text "Connect"
            await clickSelector(page, "::-p-text(Connect)", { timeout: 5000 });
        }

        await sleep(3000); // wait for connect to finish

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

async function runAntigravityWorker(
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

            await processAntigravityAccount(
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

            appendErrorAccount(account, error.message, "Antigravity");
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
        label: `Antigravity W${workerIndex + 1}`,
    };
}

async function runAntigravityAutomation(sharedProgress = null, useProxy = true) {
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
            `🚀 Antigravity Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`antigravity-${i}`, chunk.length, `Antigravity W${i + 1}`);
    });

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;
            return runAntigravityWorker(
                chunk,
                `antigravity-${i}`,
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
        printReport("🚀 ANTIGRAVITY AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `Antigravity finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();
    return { successCount, failedCount, results };
}

module.exports = {
    runAntigravityAutomation,
};