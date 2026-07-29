const {
    sleep,
    appendErrorAccount,
    acquireAccountLock,
    releaseAccountLock,
    tryAcquireAccountLock,
} = require("../../utils");
const BaseWorker = require("../base/BaseWorker");
const {
    readCodebuddyAccounts,
    removeCodebuddyAccount,
    processCodebuddyAccount,
} = require("./index");

const QUEUE_RETRY_DELAY_MS = 500;

class CodebuddyWorker extends BaseWorker {
    constructor(workerAccounts, workerId, browserArgsIndex, workerIndex, total, progress, log, useProxy = true) {
        super(workerAccounts, workerId, browserArgsIndex, workerIndex, total, progress, log);
        this.useProxy = useProxy;
    }

    getAutomationName() {
        return "Codebuddy";
    }

    async processAccount(account, browserArgsIndex, workerIndex) {
        await processCodebuddyAccount(
            account,
            browserArgsIndex,
            workerIndex,
            this.log,
            this.updateProgress.bind(this),
            this.useProxy,
        );
    }

    readAccounts() {
        return readCodebuddyAccounts();
    }

    removeAccount(account) {
        removeCodebuddyAccount(account);
    }

    async tryAcquireLock(email) {
        if (this.queue.length > 1) {
            if (!tryAcquireAccountLock(email)) {
                this.log(`[${this.workerId}] ${email} is locked, moving to back of queue.`);
                this.queue.push(this.queue.shift());
                await sleep(QUEUE_RETRY_DELAY_MS);
                return false;
            }
            return true;
        }
        return false;
    }

    async acquireLock(email) {
        await acquireAccountLock(email, this.log, this.updateProgress.bind(this));
    }

    releaseLock(email) {
        releaseAccountLock(email);
    }

    appendError(account, errorMessage) {
        appendErrorAccount(account, errorMessage, this.getAutomationName());
    }
}

module.exports = CodebuddyWorker;
