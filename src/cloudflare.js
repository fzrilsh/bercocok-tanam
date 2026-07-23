const { getConfig, getResultFile, SHARED_SELECTORS } = require("./config");
const {
    sleep,
    readAccounts,
    removeAccount,
    appendErrorAccount,
    chunkAccounts,
    createFileLogger,
    formatDuration,
    ensureFileExists,
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
const { createRouter } = require("./9router-helper");
const fs = require("fs");

const TARGET_URL = "https://dash.cloudflare.com/login";
const QUEUE_RETRY_DELAY_MS = 500; // Wait before retrying locked account from queue
const MODELS =
    '["@cf/zai-org/glm-5.2","@cf/deepseek-ai/deepseek-r1-distill-qwen-32b","@cf/meta/llama-3.3-70b-instruct-fp8-fast","@cf/qwen/qwen2.5-coder-32b-instruct","@cf/qwen/qwq-32b"]';

async function openCFSignIn(page, log) {
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
            timeout: config.timeouts.default,
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
            config.timeouts.default,
        );
    } catch (_) {
        log("No Login button found");
    }
}

async function waitForDashboard(page, log) {
    const config = getConfig();

    log("Waiting for CF dashboard...");
    await page.waitForFunction(
        () => {
            const url = window.location.href;

            return (
                url.includes("dash.cloudflare.com") &&
                !url.includes("/login") &&
                !url.includes("oidcJwt")
            );
        },
        { timeout: config.timeouts.navigation },
    );

    log("Redirected to CF dashboard!");
}

async function harvestToken(page, log) {
    log("Getting account ID...");

    const accountResult = await page.evaluate(async () => {
        try {
            const resp = await fetch("/api/v4/accounts", {
                credentials: "include",
                headers: { Accept: "application/json" },
            });

            const data = await resp.json();

            return { status: resp.status, success: data.success, data };
        } catch (e) {
            return { status: 0, success: false, error: e.message };
        }
    });

    log(`GET /api/v4/accounts → ${accountResult.status}`);

    if (accountResult.status !== 200 || !accountResult.success) {
        throw new Error(
            `Account list failed: ${JSON.stringify(accountResult.data?.errors || [])}`,
        );
    }

    const accounts = accountResult.data?.result || [];

    if (accounts.length === 0) {
        throw new Error("No accounts found");
    }

    const accountId = accounts[0]?.id;

    if (!accountId) {
        throw new Error("Empty account ID");
    }

    log(`Account ID: ${accountId}`);
    log("Getting permission groups...");

    const permResult = await page.evaluate(async () => {
        try {
            const resp = await fetch("/api/v4/user/tokens/permission_groups", {
                credentials: "include",
                headers: { Accept: "application/json" },
            });

            const data = await resp.json();

            return { status: resp.status, success: data.success, data };
        } catch (e) {
            return { status: 0, success: false, error: e.message };
        }
    });

    log(`GET /api/v4/user/tokens/permission_groups → ${permResult.status}`);

    if (permResult.status !== 200 || !permResult.success) {
        throw new Error(
            `Permission groups failed: ${JSON.stringify(permResult.data?.errors || [])}`,
        );
    }

    const groups = permResult.data?.result || [];
    const permIds = groups
        .filter((g) => (g.name || "").toLowerCase().includes("workers ai"))
        .map((g) => ({ id: g.id, name: g.name || "" }));

    if (permIds.length === 0) {
        throw new Error("No Workers AI permission groups found");
    }

    log(`Found ${permIds.length} Workers AI permission groups`);
    log("Creating API token...");

    const payload = {
        name: `cf-ai-${Math.floor(Date.now() / 1000)}`,
        policies: [
            {
                effect: "allow",
                permission_groups: permIds.map((p) => ({ id: p.id })),
                resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            },
        ],
    };

    const tokenResult = await page.evaluate(async (payloadStr) => {
        try {
            const resp = await fetch("/api/v4/user/tokens", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                },
                credentials: "include",
                body: payloadStr,
            });

            const data = await resp.json();

            return { status: resp.status, success: data.success, data };
        } catch (e) {
            return { status: 0, success: false, error: e.message };
        }
    }, JSON.stringify(payload));

    log(`POST /api/v4/user/tokens → ${tokenResult.status}`);

    if (tokenResult.status !== 200 || !tokenResult.success) {
        throw new Error(
            `Token creation failed: ${JSON.stringify(tokenResult.data?.errors || [])}`,
        );
    }

    const token = tokenResult.data?.result?.value;

    if (!token) {
        throw new Error("Empty token value");
    }

    log(`Token: ${token.slice(0, 25)}...`);

    return { accountId, token };
}

function saveToken(accountId, token, log) {
    const resultFile = getResultFile("cloudflare");
    const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;

    ensureFileExists(resultFile);

    fs.appendFileSync(
        resultFile,
        `cloudflare_${accountId.slice(0, 6)}|${baseUrl}|${token}|${MODELS}\n`,
    );

    log(`Token saved to ${resultFile}`);
}

async function validateAndImport(apiKey, accountId, log) {
    const { ok, router, error } = await createRouter(null, log);
    if (!ok) throw new Error(`Router ${error}`);

    try {
        log("Validating provider...");
        await router.validateProvider("cloudflare-ai", apiKey, { accountId });
        log("Validation OK");
    } catch (valErr) {
        log(`Validation warning (continuing): ${valErr.message}`);
    }

    const connectionName = `cloudflare_${accountId.slice(0, 6)}`;
    log(`Importing as "${connectionName}"...`);
    await router.importProvider(
        "cloudflare-ai",
        connectionName,
        apiKey,
        { providerSpecificData: { accountId } },
    );
    log("Successfully imported!");
}

async function processCFAccount(
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

    const { browser, page } = await launchBrowser(
        browserArgsIndex,
        workerIndex,
        proxy,
    );

    try {
        updateProgress({ step: STEPS.NAVIGATING });
        await openCFSignIn(page, log);

        updateProgress({ step: STEPS.GOOGLE_LOGIN });
        await completeGoogleLogin(page, account, log);
        await handlePostLogin(page, log);

        updateProgress({ step: STEPS.WAITING });
        await waitForDashboard(page, log);

        updateProgress({ step: STEPS.HARVESTING });
        const { accountId, token } = await harvestToken(page, log);
        saveToken(accountId, token, log);

        updateProgress({ step: STEPS.VALIDATING });
        try {
            await validateAndImport(token, accountId, log);
        } catch (importErr) {
            log(`Router import failed (continuing): ${importErr.message}`);
        }

        removeAccount(account.rawLine);
        log(`Account harvest + import successful! Removed: ${account.email}`);

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

async function runCFWorker(
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
                log(
                    `[${workerId}] ${account.email} is locked, moving to back of queue.`,
                );
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

            await processCFAccount(
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

            appendErrorAccount(account, error.message, "Cloudflare");
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
        label: `CF W${workerIndex + 1}`,
    };
}

async function runCloudflareAutomation(sharedProgress = null, useProxy = true) {
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
            `☁️  Cloudflare Automation — ${accounts.length} accounts, ${chunks.length} workers`,
        );

    chunks.forEach((chunk, i) => {
        progress.addWorker(`cf-${i}`, chunk.length, `CF W${i + 1}`);
    });

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return runCFWorker(
                chunk,
                `cf-${i}`,
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
        printReport("☁️  CLOUDFLARE AUTOMATION REPORT", results, totalDuration);
        console.log(`📄 Log: ${logger.logFile}`);
        console.log("");
    } else {
        const duration = formatDuration(totalDuration);
        logger.log(
            `Cloudflare finished. Success: ${successCount}, Failed: ${failedCount}, Duration: ${duration}`,
        );
    }

    logger.close();

    return { successCount, failedCount, results };
}

module.exports = {
    runCloudflareAutomation,
};
