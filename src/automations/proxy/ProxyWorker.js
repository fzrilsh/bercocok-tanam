const { getConfig, getResultFile } = require("../../config");
const { sleep, ensureFileExists } = require("../../utils");
const { launchBrowser } = require("../../browser");
const { STEPS } = require("../../cli/progress");
const BaseWorker = require("../base/BaseWorker");
const fs = require("fs");

class ProxyWorker extends BaseWorker {
    constructor(openProxySignUp, handleGoogleLoginPopup, waitForDashboard, goToProxyList, fetchProxies) {
        super({
            automationName: "Proxy",
            workerLabel: "Proxy W",
            removeAccountOnSuccess: true,
            appendErrorOnFailure: true,
            rotateBrowserArgsOnError: true,
            useProxyPool: false,
        });

        this.openProxySignUp = openProxySignUp;
        this.handleGoogleLoginPopup = handleGoogleLoginPopup;
        this.waitForDashboard = waitForDashboard;
        this.goToProxyList = goToProxyList;
        this.fetchProxies = fetchProxies;
    }

    saveProxies(proxies, log) {
        const resultFile = getResultFile("proxy");

        ensureFileExists(resultFile);

        proxies.forEach((proxy) => {
            const line = `${proxy.proxy_address}:${proxy.port}:${proxy.username}:${proxy.password}\n`;
            fs.appendFileSync(resultFile, line);
        });

        log(`Saved ${proxies.length} proxies to ${resultFile}`);
    }

    async processAccount(account, browserArgsIndex, workerIndex, log, updateProgress, useProxy) {
        const config = getConfig();

        updateProgress({ step: STEPS.LAUNCHING, email: account.email });
        log(`Launching browser for ${account.email}`);

        const { browser, page } = await launchBrowser(
            browserArgsIndex,
            workerIndex,
            account.proxy || null,
        );

        try {
            updateProgress({ step: STEPS.NAVIGATING });
            await this.openProxySignUp(page, log);

            updateProgress({ step: STEPS.GOOGLE_LOGIN });
            await this.handleGoogleLoginPopup(page, account, log);

            updateProgress({ step: STEPS.WAITING });
            await this.waitForDashboard(page, log);

            updateProgress({ step: STEPS.HARVESTING });
            const planId = await this.goToProxyList(page, log);

            updateProgress({ step: STEPS.GETTING_TOKEN });
            const proxies = await this.fetchProxies(page, planId, log);
            this.saveProxies(proxies, log);

            await sleep(config.delays.beforeBrowserClose);
        } finally {
            await browser.close();
            log("Browser closed.");
        }
    }
}

module.exports = ProxyWorker;
