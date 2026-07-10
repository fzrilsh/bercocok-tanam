const os = require("os");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const { getConfig } = require("./config");
const { randomUA } = require("./utils");

const createUserDataDir = () =>
    path.join(os.tmpdir(), `puppeteer_bt_${Math.random().toString(36).slice(2)}`);

function parseProxyForPuppeteer(proxy) {
    if (!proxy) {return null;}

    const result = { server: proxy };

    if (proxy.includes("@")) {
        const [prefix, rest] = proxy.split("://", 2);
        const atIdx = rest.lastIndexOf("@");

        result.server = `${prefix}://${rest.slice(atIdx + 1)}`;

        const userPass = rest.slice(0, atIdx);
        const colonIdx = userPass.indexOf(":");

        if (colonIdx !== -1) {
            result.username = userPass.slice(0, colonIdx);
            result.password = userPass.slice(colonIdx + 1);
        }
    }

    return result;
}

async function launchBrowser(browserArgsIndex, workerIndex, proxy) {
    const config = getConfig();
    const extraArgs = ["--start-maximized"];

    if (proxy) {
        const parsed = parseProxyForPuppeteer(proxy);

        if (parsed) {
            extraArgs.push(`--proxy-server=${parsed.server}`);
        }
    }

    const browser = await puppeteer.launch({
        headless: config.headless,
        slowMo: config.slowMo,
        executablePath: config.chromeExecutablePath,
        defaultViewport: null,
        args: [...config.browserArgsSets[browserArgsIndex], ...extraArgs],
        userDataDir: createUserDataDir(),
        ignoreDefaultArgs: ["--enable-automation"],
    });

    const [page] = await browser.pages();
    await page.setUserAgent(randomUA());

    return { browser, page };
}

module.exports = {
    launchBrowser,
};
