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
const CloudflareWorker = require("./CloudflareWorker");

const TARGET_URL = "https://dash.cloudflare.com/login";

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

    const worker = new CloudflareWorker(
        openCFSignIn,
        handlePostLogin,
        waitForDashboard,
        harvestToken,
    );

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;

            return worker.run(
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
