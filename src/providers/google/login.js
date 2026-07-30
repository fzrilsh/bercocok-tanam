const { getConfig } = require("../../config");
const { sleep } = require("../../utils");
const { clickSelector, typeIntoSelector, clickFirstVisibleSelector } = require("../../browser/helpers");

const GOOGLE_SELECTORS = {
    emailInput: "#identifierId",
    emailNext: "#identifierNext",
    passwordInput: 'input[type="password"]',
    passwordNext: "#passwordNext",
};

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
};
