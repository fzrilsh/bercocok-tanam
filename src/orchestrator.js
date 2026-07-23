const colors = require("ansi-colors");
const {
    readAccounts,
    removeAccount,
    appendErrorAccount,
    chunkAccounts,
    createFileLogger,
    formatDuration,
    acquireProxy,
    releaseProxy,
} = require("./utils");
const { getConfig } = require("./config");
const { launchBrowser, openWorkerPage, closePageSafe, closeExtraPages } = require("./browser");
const { STEPS, createProgressManager } = require("./progress");
const { printReport } = require("./reporter");

const { processKiroOnBrowser } = require("./kiro");
const { processGrokCLIOnBrowser } = require("./GrokCLI");
const { processCFOnBrowser } = require("./cloudflare");
const { processCodebuddyOnBrowser } = require("./codebuddy");
const { processTokenGoOnBrowser } = require("./tokengo");
const { processAerolinkOnBrowser } = require("./aerolink");
const { processAntigravityOnBrowser } = require("./antigravity");

const PROVIDERS = {
    kiro: { name: "Kiro", run: processKiroOnBrowser },
    grokCLI: { name: "GrokCLI", run: processGrokCLIOnBrowser },
    cloudflare: { name: "Cloudflare", run: processCFOnBrowser },
    codebuddy: { name: "Codebuddy", run: processCodebuddyOnBrowser },
    tokengo: { name: "TokenGo", run: processTokenGoOnBrowser },
    aerolink: { name: "Aerolink", run: processAerolinkOnBrowser },
    antigravity: { name: "Antigravity", run: processAntigravityOnBrowser },
};

async function processAccountProviders(account, selected, browser, proxyAuth, proxy, log, updateProgress, anchorPage) {
    const providerResults = [];

    for (const type of selected) {
        const provider = PROVIDERS[type];
        if (!provider) {
            providerResults.push({ type, name: type, success: false, error: "Unknown provider" });
            continue;
        }

        let page = null;
        const started = Date.now();
        try {
            updateProgress({
                step: `${provider.name}: ${STEPS.LAUNCHING}`,
                email: account.email,
            });
            // Keep anchorPage open — closing last Chrome tab kills the browser
            page = await openWorkerPage(browser, proxyAuth);
            log(`[${provider.name}] Starting for ${account.email}`);

            await provider.run(account, {
                browser,
                page,
                proxy,
                log: (msg) => log(`[${provider.name}] ${msg}`),
                updateProgress: (payload) => {
                    const step = payload.step
                        ? `${provider.name}: ${payload.step}`
                        : `${provider.name}`;
                    updateProgress({ ...payload, step, email: account.email });
                },
            });

            providerResults.push({
                type,
                name: provider.name,
                success: true,
                error: null,
                duration: Date.now() - started,
            });
            log(`[${provider.name}] OK`);
        } catch (error) {
            const message = error.message || String(error);
            providerResults.push({
                type,
                name: provider.name,
                success: false,
                error: message,
                duration: Date.now() - started,
            });
            appendErrorAccount(account, message, provider.name);
            log(`[${provider.name}] FAIL: ${message}`);
            updateProgress({ step: `${provider.name}: ${STEPS.ERROR}`, email: account.email });
        } finally {
            await closePageSafe(page);
            await closeExtraPages(browser, [anchorPage]);
        }
    }

    return providerResults;
}

async function runSharedWorker(
    workerAccounts,
    workerId,
    browserArgsIndex,
    workerIndex,
    selected,
    useProxy,
    progress,
    log,
) {
    const config = getConfig();
    let successCount = 0;
    let failedCount = 0;
    const accountStats = [];

    for (let i = 0; i < workerAccounts.length; i += 1) {
        const account = workerAccounts[i];
        let poolProxy = null;
        let browser = null;
        const started = Date.now();

        progress.updateWorker(workerId, {
            current: i,
            email: account.email,
            step: STEPS.LAUNCHING,
            success: successCount,
            failed: failedCount,
        });

        try {
            let proxy = account.proxy || null;
            if (!proxy && useProxy && config.proxyPoolFile) {
                poolProxy = await acquireProxy(log, (p) => progress.updateWorker(workerId, p));
                proxy = poolProxy;
            }

            log(`[${workerId}] Launching browser for ${account.email}`);
            const launched = await launchBrowser(browserArgsIndex, workerIndex, proxy);
            browser = launched.browser;
            // Keep initial page as anchor — Chrome dies if last tab closes
            const anchorPage = launched.page;

            const providerResults = await processAccountProviders(
                account,
                selected,
                browser,
                launched.proxyAuth || null,
                proxy,
                log,
                (payload) => progress.updateWorker(workerId, {
                    ...payload,
                    success: successCount,
                    failed: failedCount,
                }),
                anchorPage,
            );

            // Always remove after all providers attempted (user policy)
            removeAccount(account.rawLine);
            log(`[${workerId}] Removed account after attempt: ${account.email}`);

            const anySuccess = providerResults.some((r) => r.success);
            const allSuccess = providerResults.every((r) => r.success);
            const summary = providerResults
                .map((r) => (r.success ? `${r.name}:ok` : `${r.name}:fail(${r.error})`))
                .join(" | ");

            if (allSuccess) {
                successCount += 1;
            } else if (anySuccess) {
                // partial: count as failed for retry purposes but note partial
                failedCount += 1;
            } else {
                failedCount += 1;
            }

            accountStats.push({
                email: account.email,
                rawLine: account.rawLine,
                success: allSuccess,
                partial: anySuccess && !allSuccess,
                error: allSuccess ? null : summary,
                providers: providerResults,
                duration: Date.now() - started,
            });

            progress.updateWorker(workerId, {
                current: i + 1,
                email: account.email,
                step: allSuccess ? STEPS.DONE : STEPS.ERROR,
                success: successCount,
                failed: failedCount,
            });
        } catch (error) {
            failedCount += 1;
            const message = error.message || String(error);
            appendErrorAccount(account, message, "Orchestrator");
            try {
                removeAccount(account.rawLine);
            } catch {
                // ignore
            }
            accountStats.push({
                email: account.email,
                rawLine: account.rawLine,
                success: false,
                partial: false,
                error: message,
                providers: [],
                duration: Date.now() - started,
            });
            progress.updateWorker(workerId, {
                current: i + 1,
                email: account.email,
                step: STEPS.ERROR,
                success: successCount,
                failed: failedCount,
            });
            log(`[${workerId}] Account error: ${message}`);
        } finally {
            if (browser) {
                await browser.close().catch(() => {});
                log(`[${workerId}] Browser closed`);
            }
            if (poolProxy) {
                releaseProxy(poolProxy);
                log(`[${workerId}] Proxy released`);
            }
        }
    }

    return {
        label: workerId,
        accounts: accountStats,
        successCount,
        failedCount,
    };
}

/**
 * Account-centric multi-provider run.
 * 1 account = 1 Chrome; selected providers sequential via new pages.
 *
 * @param {string[]} selected provider keys
 * @param {Record<string, boolean>} proxySettings per-provider proxy flags from menu
 * @returns {Promise<{successCount:number, failedCount:number, results:any[], perProvider:Record<string,{success:number,failed:number}>}>}
 */
async function runAccountCentric(selected, proxySettings = {}) {
    const config = getConfig();
    const accounts = readAccounts();
    if (!accounts.length) {
        console.log(colors.yellow("No accounts found."));
        return { successCount: 0, failedCount: 0, results: [], perProvider: {} };
    }

    const useProxy = selected.some((t) => proxySettings[t] !== false);
    const chunks = chunkAccounts(accounts, config.browserCount);
    const logger = createFileLogger();
    const startedAt = Date.now();

    const title = `SHARED BROWSER — ${accounts.length} accounts × ${selected.length} providers, ${chunks.length} workers`;
    const progress = createProgressManager(title);

    chunks.forEach((chunk, i) => {
        progress.addWorker(`shared-${i}`, chunk.length, `W${i + 1}`);
    });

    logger.log(`Selected: ${selected.join(", ")} | useProxy=${useProxy}`);

    const results = await Promise.all(
        chunks.map((chunk, i) => {
            const browserArgsIndex = i % config.browserArgsSets.length;
            return runSharedWorker(
                chunk,
                `shared-${i}`,
                browserArgsIndex,
                i,
                selected,
                useProxy,
                progress,
                logger.log,
            );
        }),
    );

    progress.stop();

    const successCount = results.reduce((s, r) => s + r.successCount, 0);
    const failedCount = results.reduce((s, r) => s + r.failedCount, 0);
    const totalDuration = Date.now() - startedAt;

    // per-provider aggregates
    const perProvider = {};
    selected.forEach((t) => {
        perProvider[t] = { success: 0, failed: 0, name: PROVIDERS[t]?.name || t };
    });
    results.forEach((worker) => {
        worker.accounts.forEach((acc) => {
            (acc.providers || []).forEach((p) => {
                if (!perProvider[p.type]) {
                    perProvider[p.type] = { success: 0, failed: 0, name: p.name };
                }
                if (p.success) {perProvider[p.type].success += 1;} else {perProvider[p.type].failed += 1;}
            });
        });
    });

    printReport("🔗 SHARED-BROWSER AUTOMATION REPORT", results, totalDuration);

    Object.values(perProvider).forEach((p) => {
        console.log(
            `  ${p.name}: ${colors.green(`${p.success} success`)} ${colors.red(`${p.failed} failed`)}`,
        );
    });
    console.log("");
    console.log(`📝 Log: ${logger.logFile}`);
    console.log(`Duration: ${formatDuration(totalDuration)}`);
    console.log("");

    logger.log(
        `Finished. Accounts ok=${successCount} fail=${failedCount} duration=${formatDuration(totalDuration)}`,
    );
    logger.close();

    return { successCount, failedCount, results, perProvider };
}

module.exports = {
    runAccountCentric,
    PROVIDERS,
};
