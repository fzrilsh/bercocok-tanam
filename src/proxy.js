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
    clickSelector,
    clickFirstVisibleSelector,
} = require("./google-login");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const TARGET_URL = "https://dashboard.webshare.io/register";
const WORKER_STAGGER_MS = 10 * 1000; // 10 seconds between worker starts to avoid rate limiting
const GOOGLE_SELECTORS = {
    emailInput: "#identifierId",
    emailNext: "#identifierNext",
    passwordInput: 'input[type="password"]',
    passwordNext: "#passwordNext",
};

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
        await page.keyboard.press("End");

        await clickFirstVisibleSelector(
            page,
            SHARED_SELECTORS.loginOptions,
            config.timeouts.short,
        );
    } catch (_) {
        log("No Login button found");
    }
}

async function openProxySignUp(page, log) {
    const config = getConfig();

    log(`Navigating to ${TARGET_URL}`);
    await page.goto(TARGET_URL, {
        waitUntil: "networkidle2",
        timeout: config.timeouts.navigation,
    });

    log("Clicking checkbox...");
    await clickSelector(page, 'input[type="checkbox"]');

    log("Clicking Google Sign Up button...");
    await clickSelector(page, "::-p-text(Sign Up With Google)");
}

async function handleGoogleLoginPopup(page, account, log) {
    const config = getConfig();

    log("Waiting for Google login popup...");

    const popup = await new Promise((resolve) => {
        page.once("popup", resolve);
    });

    await popup.waitForSelector(GOOGLE_SELECTORS.emailInput, {
        timeout: config.timeouts.default,
    });

    log("Google popup detected");
    log(`Typing email: ${account.email}`);
    await popup.type(GOOGLE_SELECTORS.emailInput, account.email);

    log("Clicking Next (email)...");
    await sleep(config.delays.beforeNextClick);
    await popup.click(GOOGLE_SELECTORS.emailNext);

    log("Waiting for password field...");
    await popup.waitForSelector(GOOGLE_SELECTORS.passwordInput, {
        visible: true,
        timeout: config.timeouts.default,
    });
    await sleep(config.delays.beforeNextClick);
    await popup.type(GOOGLE_SELECTORS.passwordInput, account.password);

    log("Clicking Next (password)...");
    await popup.click(GOOGLE_SELECTORS.passwordNext);

    await handlePostLogin(popup, log);

    log("Waiting for popup to close...");
    await sleep(config.delays.beforeNextClick * 3);
}

async function waitForDashboard(page, log) {
    const config = getConfig();

    log("Waiting for dashboard...");
    await page.waitForFunction(
        () => window.location.href.includes("dashboard.webshare.io/dashboard"),
        { timeout: config.timeouts.navigation },
    );

    log("Redirected to dashboard!");
}

async function goToProxyList(page, log) {
    const config = getConfig();

    log("Clicking quick start button...");
    await clickSelector(page, '[data-testid="quick-start-go-to-proxy-list"]', {
        timeout: config.timeouts.default,
    });

    log("Waiting for proxy list page...");
    await page.waitForFunction(
        () => {
            const url = window.location.href;
            return url.includes("dashboard.webshare.io") && url.includes("/proxy");
        },
        { timeout: config.timeouts.navigation },
    );

    const currentUrl = page.url();
    log(`Proxy list page loaded: ${currentUrl}`);

    const match = currentUrl.match(/dashboard\.webshare\.io\/(\d+)\/proxy/);
    if (!match || !match[1]) {
        throw new Error("Failed to extract plan_id from URL");
    }

    const planId = match[1];
    log(`Extracted plan_id: ${planId}`);

    return planId;
}

async function fetchProxies(page, planId, log) {
    log("Getting ssotoken cookie...");

    const cookies = await page.cookies();
    const ssotokenCookie = cookies.find((c) => c.name === "ssotoken");

    if (!ssotokenCookie?.value) {
        throw new Error("ssotoken cookie not found");
    }

    const ssotoken = ssotokenCookie.value;
    log(`Got ssotoken (${ssotoken.slice(0, 20)}...)`);

    log("Fetching proxy list...");

    const proxyData = await page.evaluate(async (planId, ssotoken) => {
        try {
            const resp = await fetch(
                `https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=10&plan_id=${planId}`,
                {
                    headers: {
                        accept: "application/json, text/plain, */*",
                        authorization: `Token ${ssotoken}`,
                    },
                    method: "GET",
                },
            );

            const data = await resp.json();
            return { status: resp.status, data };
        } catch (e) {
            return { status: 0, error: e.message };
        }
    }, planId, ssotoken);

    log(`GET /api/v2/proxy/list/ → ${proxyData.status}`);

    if (proxyData.status !== 200) {
        throw new Error(
            `Proxy fetch failed: ${proxyData.error || JSON.stringify(proxyData.data)}`,
        );
    }

    const results = proxyData.data?.results || [];
    if (results.length === 0) {
        throw new Error("No proxies found");
    }

    log(`Found ${results.length} proxies`);

    return results;
}

function saveProxies(proxies, log) {
    const resultFile = getResultFile("proxy");

    ensureFileExists(resultFile);

    proxies.forEach((proxy) => {
        const line = `${proxy.proxy_address}:${proxy.port}:${proxy.username}:${proxy.password}\n`;
        fs.appendFileSync(resultFile, line);
    });

    log(`Saved ${proxies.length} proxies to ${resultFile}`);
}

async function processProxyAccount(
    account,
    browserArgsIndex,
    workerIndex,
    log,
    updateProgress,
) {
    const config = getConfig();
    const poolProxy = null;
    const proxy = account.proxy || null;

    // Skip proxy pool for proxy automation - free datacenter proxies trigger Google CAPTCHA
    // Use direct connection for registration, get clean proxies from successful signups
    // if (!proxy && config.proxyPoolFile) {
    //     poolProxy = await acquireProxy(log, updateProgress);
    //     proxy = poolProxy;
    // }

    updateProgress({ step: STEPS.LAUNCHING, email: account.email });
    log(`Launching browser for ${account.email}`);

    const { browser, page } = await launchBrowser(
        browserArgsIndex,
        workerIndex,
        proxy,
    );

    try {
        updateProgress({ step: STEPS.NAVIGATING });
        await openProxySignUp(page, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        await handleGoogleLoginPopup(page, account, log);

        updateProgress({ step: STEPS.WAITING });
        await waitForDashboard(page, log);

        updateProgress({ step: STEPS.HARVESTING });
        const planId = await goToProxyList(page, log);

        updateProgress({ step: STEPS.GETTING_TOKEN });
        const proxies = await fetchProxies(page, planId, log);
        saveProxies(proxies, log);

        removeAccount(account.rawLine);
        log(`Account successful! Removed: ${account.email}`);

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

async function runProxyWorker(
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

            await processProxyAccount(
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

            appendErrorAccount(account, error.message, "Proxy");
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
        label: `Proxy W${workerIndex + 1}`,
    };
}

async function runProxyAutomation(sharedProgress = null) {
    const config = getConfig();
    const logger = createFileLogger();
    const accounts = readAccounts();

    if (accounts.length === 0) {
        if (!sharedProgress) {
            console.log(
                "No accounts found. Format: email|password or email|password|proxy",
            );
        }
        logger.close();

        return null;
    }

    const startedAt = Date.now();
    const reversedAccounts = [...accounts].reverse();
    const chunks = chunkAccounts(reversedAccounts, config.browserCount);

    const progress =
        sharedProgress ||
        createProgressManager(
            `🔐 Proxy Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`proxy-${i}`, chunk.length, `Proxy W${i + 1}`);
    });

    // Stagger worker starts to avoid rate limiting on registration endpoint
    const workerPromises = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const browserArgsIndex = i % config.browserArgsSets.length;

        if (i > 0) {
            await sleep(WORKER_STAGGER_MS);
        }

        workerPromises.push(
            runProxyWorker(
                chunk,
                `proxy-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
            ),
        );
    }

    const results = await Promise.all(workerPromises);

    if (!sharedProgress) {
        progress.stop();
    }

    const successCount = results.reduce((sum, r) => sum + r.successCount, 0);
    const failedCount = results.reduce((sum, r) => sum + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    if (!sharedProgress) {
        printReport("🔐 PROXY AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `Proxy finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runProxyAutomation,
};
