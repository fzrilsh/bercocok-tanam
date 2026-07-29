const { getConfig } = require("../../config");
const { sleep, ensureFileExists } = require("../../utils");
const { launchBrowser } = require("../../browser");
const { completeGoogleLogin } = require("../../providers/google/login");
const { STEPS } = require("../../cli/progress");
const BaseWorker = require("../base/BaseWorker");
const fs = require("fs");
const { getResultFile } = require("../../config");
const { createRouter } = require("../../providers/router");

class KiroWorker extends BaseWorker {
    constructor(openKiroSignIn, handlePostLogin, waitForDashboard, getRefreshToken) {
        super({
            automationName: "Kiro",
            workerLabel: "Kiro W",
            removeAccountOnSuccess: true,
            appendErrorOnFailure: true,
            rotateBrowserArgsOnError: true,
            useProxyPool: true,
        });

        this.openKiroSignIn = openKiroSignIn;
        this.handlePostLogin = handlePostLogin;
        this.waitForDashboard = waitForDashboard;
        this.getRefreshToken = getRefreshToken;
    }

    saveRefreshToken(email, refreshToken, log) {
        const resultFile = getResultFile("kiro");
        ensureFileExists(resultFile);
        fs.appendFileSync(resultFile, `${email}|${refreshToken}\n`);
        log(`Refresh token saved to ${resultFile}`);
    }

    async importRefreshToken(refreshToken, log) {
        const { ok, router, error } = await createRouter(null, log);
        if (!ok) {
            throw new Error(`Router ${error}`);
        }

        log("Importing refresh token to router...");
        await router.importRefreshToken("kiro", refreshToken);
        log("Successfully imported token!");
    }

    async processAccount(account, browserArgsIndex, workerIndex, log, updateProgress, useProxy) {
        const config = getConfig();
        
        const { proxy, poolProxy } = await this.acquireProxyForAccount(
            account,
            log,
            updateProgress,
            useProxy,
        );

        updateProgress({ step: STEPS.LAUNCHING, email: account.email });
        log(`Launching browser for ${account.email}`);

        const { browser, page } = await launchBrowser(
            browserArgsIndex,
            workerIndex,
            proxy,
        );

        try {
            updateProgress({ step: STEPS.NAVIGATING });
            await this.openKiroSignIn(page, log);

            updateProgress({ step: STEPS.GOOGLE_LOGIN });
            await completeGoogleLogin(page, account, log);
            await this.handlePostLogin(page, log);

            updateProgress({ step: STEPS.WAITING });
            await this.waitForDashboard(page, log);

            updateProgress({ step: STEPS.GETTING_TOKEN });
            const refreshToken = await this.getRefreshToken(page, log);
            this.saveRefreshToken(account.email, refreshToken, log);

            updateProgress({ step: STEPS.IMPORTING });
            try {
                await this.importRefreshToken(refreshToken, log);
            } catch (importErr) {
                log(`Router import failed (continuing): ${importErr.message}`);
            }

            await sleep(config.delays.beforeBrowserClose);
        } finally {
            await browser.close();
            log("Browser closed.");
            this.releaseProxyForAccount(poolProxy, log);
        }
    }
}

module.exports = KiroWorker;
