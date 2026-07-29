const { getConfig } = require("../../config");
const {
    sleep,
    removeAccount,
    appendErrorAccount,
    acquireAccountLock,
    releaseAccountLock,
    tryAcquireAccountLock,
    acquireProxy,
    releaseProxy,
} = require("../../utils");
const { STEPS } = require("../../cli/progress");

const QUEUE_RETRY_DELAY_MS = 500;

class BaseWorker {
    constructor(options = {}) {
        this.automationName = options.automationName || "Unknown";
        this.workerLabel = options.workerLabel || "Worker";
        this.removeAccountOnSuccess = options.removeAccountOnSuccess !== false;
        this.appendErrorOnFailure = options.appendErrorOnFailure !== false;
        this.rotateBrowserArgsOnError = options.rotateBrowserArgsOnError !== false;
        this.useProxyPool = options.useProxyPool !== false;
    }

    async processAccount(account, browserArgsIndex, workerIndex, log, updateProgress, useProxy) {
        throw new Error("processAccount() must be implemented by child class");
    }

    onAccountSuccess(account, log) {
        if (this.removeAccountOnSuccess) {
            removeAccount(account.rawLine);
            log(`Account success! Removed from accounts file: ${account.email}`);
        }
    }

    onAccountFailure(account, error, log) {
        if (this.appendErrorOnFailure) {
            appendErrorAccount(account, error.message, this.automationName);
        }
        log(`Account failed: ${error.message}`);
    }

    createUpdateProgress(workerId, progress, account, successCount, failedCount, processedCount) {
        return (payload) => {
            progress.updateWorker(workerId, {
                ...payload,
                email: account.email,
                success: successCount,
                failed: failedCount,
                current: processedCount,
            });
        };
    }

    async acquireProxyForAccount(account, log, updateProgress, useProxy) {
        const config = getConfig();
        let poolProxy = null;
        let proxy = account.proxy || null;

        if (!proxy && config.proxyPoolFile && useProxy && this.useProxyPool) {
            poolProxy = await acquireProxy(log, updateProgress);
            proxy = poolProxy;
        }

        return { proxy, poolProxy };
    }

    releaseProxyForAccount(poolProxy, log) {
        if (poolProxy) {
            releaseProxy(poolProxy);
            log(`[Proxy] Released: ${poolProxy.split(':')[0]}`);
        }
    }

    rotateBrowserArgs(browserArgsIndex) {
        const config = getConfig();
        return (browserArgsIndex + 1) % config.browserArgsSets.length;
    }

    async run(
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

            const updateProgress = this.createUpdateProgress(
                workerId,
                progress,
                account,
                successCount,
                failedCount,
                processedCount,
            );

            const startTime = Date.now();
            let accountSuccess = false;
            let accountError = null;

            try {
                if (!hasLock) {
                    await acquireAccountLock(account.email, log, updateProgress);
                    hasLock = true;
                }

                queue.shift();

                await this.processAccount(
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

                this.onAccountSuccess(account, log);

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

                this.onAccountFailure(account, error, log);

                if (this.rotateBrowserArgsOnError) {
                    browserArgsIndex = this.rotateBrowserArgs(browserArgsIndex);
                }

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
            label: `${this.workerLabel} ${workerIndex + 1}`,
        };
    }
}

module.exports = BaseWorker;
