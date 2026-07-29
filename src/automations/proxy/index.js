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
const ProxyWorker = require("./ProxyWorker");

const TARGET_URL = "https://dashboard.webshare.io/register";
const WORKER_STAGGER_MS = 10 * 1000;
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
    await clickSelector(page, '::-p-text(Sign Up With Google)');
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
    const ssotokenCookie = cookies.find(c => c.name === "ssotoken");

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
                }
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
            `Proxy fetch failed: ${proxyData.error || JSON.stringify(proxyData.data)}`
        );
    }

    const results = proxyData.data?.results || [];
    if (results.length === 0) {
        throw new Error("No proxies found");
    }

    log(`Found ${results.length} proxies`);

    return results;
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

    const worker = new ProxyWorker(
        openProxySignUp,
        handleGoogleLoginPopup,
        waitForDashboard,
        goToProxyList,
        fetchProxies,
    );

    // Stagger worker starts to avoid rate limiting on registration endpoint
    const workerPromises = [];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const browserArgsIndex = i % config.browserArgsSets.length;

        if (i > 0) {
            await sleep(WORKER_STAGGER_MS);
        }

        workerPromises.push(
            worker.run(
                chunk,
                `proxy-${i}`,
                browserArgsIndex,
                i,
                accounts.length,
                progress,
                logger.log,
                false,
            )
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
