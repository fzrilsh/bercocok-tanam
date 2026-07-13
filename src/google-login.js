const { getConfig } = require("./config");
const { sleep } = require("./utils");

const GOOGLE_SELECTORS = {
    emailInput: "#identifierId",
    emailNext: "#identifierNext",
    passwordInput: 'input[type="password"]',
    passwordNext: "#passwordNext",
};

async function clickSelector(page, selector, options = {}) {
    const config = getConfig();
    const {
        timeout = config.timeouts.default,
        visible = false,
        delayBeforeClick = 0,
    } = options;

    await page.waitForSelector(selector, { timeout, visible });

    if (delayBeforeClick > 0) {
        await sleep(delayBeforeClick);
    }

    // Check if Puppeteer-specific selector (not standard CSS)
    const isPuppeteerSelector = selector.includes('::-p-') ||
                                 selector.includes('>>>') ||
                                 selector.startsWith('/');

    if (isPuppeteerSelector) {
        // Must use Puppeteer click for Puppeteer selectors
        await page.click(selector);
    } else {
        // Use JavaScript click for standard CSS (more reliable in headless)
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, selector);
    }
}

async function typeIntoSelector(page, selector, value, options = {}) {
    const config = getConfig();
    const {
        timeout = config.timeouts.default,
        visible = false,
        delayBeforeType = 0,
    } = options;

    await page.waitForSelector(selector, { timeout, visible });

    if (delayBeforeType > 0) {
        await sleep(delayBeforeType);
    }

    await page.type(selector, value);
}

async function clickFirstVisibleSelector(page, selectors, timeout) {
    const config = getConfig();
    const foundSelector = await Promise.race(
        selectors.map((selector) =>
            page
                .waitForSelector(selector, { visible: true, timeout })
                .then(() => selector),
        ),
    );

    await sleep(config.delays.beforeNextClick);

    // Check if Puppeteer-specific selector
    const isPuppeteerSelector = foundSelector.includes('::-p-') ||
                                 foundSelector.includes('>>>') ||
                                 foundSelector.startsWith('/');

    if (isPuppeteerSelector) {
        // Must use Puppeteer click for Puppeteer selectors
        await page.click(foundSelector);
    } else {
        // Use JavaScript click for standard CSS (more reliable in headless)
        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) el.click();
        }, foundSelector);
    }
}

async function completeGoogleLogin(page, account, log) {
    const config = getConfig();

    log(`Typing email: ${account.email}`);
    await typeIntoSelector(page, GOOGLE_SELECTORS.emailInput, account.email);

    log("Clicking Next (email)...");
    await clickSelector(page, GOOGLE_SELECTORS.emailNext, {
        delayBeforeClick: config.delays.beforeNextClick,
    });

    log("Waiting for password field...");
    await typeIntoSelector(
        page,
        GOOGLE_SELECTORS.passwordInput,
        account.password,
        {
            visible: true,
            delayBeforeType: config.delays.beforeNextClick,
        },
    );

    log("Clicking Next (password)...");
    await clickSelector(page, GOOGLE_SELECTORS.passwordNext);
}

module.exports = {
    completeGoogleLogin,
    clickSelector,
    typeIntoSelector,
    clickFirstVisibleSelector,
};
