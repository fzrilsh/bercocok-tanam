const { getConfig } = require("./config");
const { sleep } = require("./utils");

const GOOGLE_SELECTORS = {
    emailInput: "#identifierId",
    emailNext: "#identifierNext",
    passwordInput: 'input[type="password"]',
    passwordNext: "#passwordNext",
    accountChooser: "div[data-identifier], div[data-email], li[data-identifier]",
    continueBtn: "button::-p-text(Continue)",
};

async function clickSelector(page, selector, options = {}) {
    const config = getConfig();
    const {
        timeout = config.timeouts.default,
        visible = false,
        delayBeforeClick = 0,
    } = options;

    if (Array.isArray(selector)) {
        await clickFirstVisibleSelector(page, selector, timeout);
        return;
    }

    await page.waitForSelector(selector, { timeout, visible });

    if (delayBeforeClick > 0) {
        await sleep(delayBeforeClick);
    }

    await page.click(selector);
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
    await page.click(foundSelector);
}

function isGoogleAuthUrl(url) {
    return /accounts\.google\.com|google\.com\/signin|google\.com\/oauth/i.test(url || "");
}

async function waitForAny(page, checks, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        for (const check of checks) {
            try {

                const hit = await check();
                if (hit) {return hit;}
            } catch {
                // continue
            }
        }

        await sleep(250);
    }
    return null;
}

async function pickAccountChooser(page, account, log) {
    const email = account.email.toLowerCase();
    const candidates = await page.$$(GOOGLE_SELECTORS.accountChooser);
    for (const el of candidates) {

        const id = ((await el.evaluate((n) =>
            n.getAttribute("data-identifier")
            || n.getAttribute("data-email")
            || n.textContent
            || "",
        )) || "").toLowerCase();
        if (id.includes(email)) {
            log(`Selecting existing Google session: ${account.email}`);

            await el.click();
            return true;
        }
    }
    if (candidates.length === 1) {
        log("Selecting only available Google account");
        await candidates[0].click();
        return true;
    }
    return false;
}

async function completeGoogleLogin(page, account, log) {
    const config = getConfig();
    const short = Math.min(config.timeouts.short || 10000, 8000);

    if (!isGoogleAuthUrl(page.url())) {
        log("Google session already active (skipped login form)");
        // Try clicking Account Chooser if it happens to be open despite URL
        const chooser = await page.$(GOOGLE_SELECTORS.accountChooser);
        if (chooser) {
            log("Account chooser found despite active session URL, picking account...");
            await pickAccountChooser(page, account, log);
        }
        return;
    }

    const state = await waitForAny(page, [
        async () => (await page.$(GOOGLE_SELECTORS.accountChooser) ? "chooser" : null),
        async () => (await page.$(GOOGLE_SELECTORS.continueBtn) ? "continue" : null),
        async () => (await page.$(GOOGLE_SELECTORS.emailInput) ? "email" : null),
        async () => (await page.$(GOOGLE_SELECTORS.passwordInput) ? "password" : null),
        async () => (!isGoogleAuthUrl(page.url()) ? "done" : null),
    ], short);

    if (state === "done") {
        log("Google session already active");
        return;
    }

    if (state === "continue") {
        log("Clicking Continue...");
        await clickSelector(page, GOOGLE_SELECTORS.continueBtn);
        // Wait for next state after continue
        await sleep(config.delays.beforeNextClick || 1000);
    }

    if (state === "chooser") {
        const picked = await pickAccountChooser(page, account, log);
        if (picked) {
            const next = await waitForAny(page, [
                async () => (await page.$(GOOGLE_SELECTORS.passwordInput) ? "password" : null),
                async () => (!isGoogleAuthUrl(page.url()) ? "done" : null),
                async () => (await page.$(GOOGLE_SELECTORS.continueBtn) ? "continue" : null),
                async () => (await page.$(GOOGLE_SELECTORS.emailInput) ? "email" : null),
            ], short);
            if (next === "done") {
                log("Google account chooser completed login");
                return;
            }
            if (next === "continue") {
                log("Clicking Continue...");
                await clickSelector(page, GOOGLE_SELECTORS.continueBtn);
                await sleep(config.delays.beforeNextClick || 1000);
            } else if (next === "password") {
                log("Waiting for password field...");
                await typeIntoSelector(page, GOOGLE_SELECTORS.passwordInput, account.password, {
                    visible: true,
                    delayBeforeType: config.delays.beforeNextClick,
                });
                log("Clicking Next (password)...");
                await clickSelector(page, GOOGLE_SELECTORS.passwordNext);
                return;
            }
        }
    }

    if (state === "password" || await page.$(GOOGLE_SELECTORS.passwordInput)) {
        if (!(await page.$(GOOGLE_SELECTORS.emailInput))) {
            log("Email prefilled — typing password only");
            await typeIntoSelector(page, GOOGLE_SELECTORS.passwordInput, account.password, {
                visible: true,
                delayBeforeType: config.delays.beforeNextClick,
            });
            log("Clicking Next (password)...");
            await clickSelector(page, GOOGLE_SELECTORS.passwordNext);
            return;
        }
    }

    log(`Typing email: ${account.email}`);
    await typeIntoSelector(page, GOOGLE_SELECTORS.emailInput, account.email);

    log("Clicking Next (email)...");
    await clickSelector(page, GOOGLE_SELECTORS.emailNext, {
        delayBeforeClick: config.delays.beforeNextClick,
    });

    log("Waiting for password field...");
    await typeIntoSelector(page, GOOGLE_SELECTORS.passwordInput, account.password, {
        visible: true,
        delayBeforeType: config.delays.beforeNextClick,
    });

    log("Clicking Next (password)...");
    await clickSelector(page, GOOGLE_SELECTORS.passwordNext);
}

module.exports = {
    completeGoogleLogin,
    clickSelector,
    typeIntoSelector,
    clickFirstVisibleSelector,
    pickAccountChooser,
    GOOGLE_SELECTORS,
};
