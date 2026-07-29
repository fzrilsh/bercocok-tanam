/* global URLSearchParams, URL */

/**
 * Shared OAuth utilities for automations
 * Extracted common OAuth patterns from tokengo, livrouter, codebuddy
 */

async function harvestOAuthState(axiosInstance, baseUrl, oauthStatePath, log, affCode = null) {
    let url = `${baseUrl}${oauthStatePath}`;
    if (affCode) {
        url += `?aff=${affCode}`;
        log(`Harvesting OAuth state with affiliate code: ${affCode}`);
    } else {
        log("Harvesting OAuth state...");
    }

    try {
        const response = await axiosInstance.get(url, {
            headers: {
                "Accept": "application/json",
            },
            validateStatus: (status) => status < 500,
        });

        if (response.status !== 200) {
            throw new Error(`OAuth state harvest failed: ${response.status} ${response.statusText}`);
        }

        const oauthState = response.data?.state || response.data?.data?.state;
        if (!oauthState) {
            throw new Error("OAuth state not found in response");
        }

        const setCookieHeaders = response.headers["set-cookie"] || [];
        const stateCookies = setCookieHeaders
            .map((cookieStr) => cookieStr.split(";")[0])
            .join("; ");

        log(`OAuth state harvested: ${oauthState.substring(0, 10)}...`);
        return { oauthState, stateCookies };
    } catch (error) {
        log(`Error harvesting OAuth state: ${error.message}`);
        throw error;
    }
}

function buildGoogleOAuthUrl(clientId, redirectUri, state, scope = "openid profile email") {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scope,
        state: state,
        access_type: "offline",
        prompt: "consent",
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function buildGitHubOAuthUrl(clientId, redirectUri, state, options = {}) {
    const {
        scope = "user:email",
        newSignup = false,
        useReturnTo = false,
        returnToPath = "/dashboard",
    } = options;

    const baseUrl = "https://github.com/login/oauth/authorize";
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: scope,
        state: state,
    });

    if (newSignup) {
        params.append("allow_signup", "true");
    }

    let url = `${baseUrl}?${params.toString()}`;

    if (useReturnTo) {
        const returnToUrl = `${redirectUri}?${params.toString()}`;
        url = `${baseUrl}?return_to=${encodeURIComponent(returnToUrl)}`;
    }

    return url;
}

async function fillGitHubLoginForm(page, email, password, log, options = {}) {
    const {
        emailSelector = "input#login_field",
        passwordSelector = "input#password",
        delay = 50,
    } = options;

    log("Filling GitHub login form...");

    try {
        const emailInput = await page.waitForSelector(emailSelector, {
            timeout: 15000,
            visible: true,
        });
        await emailInput.click({ clickCount: 3 });
        await emailInput.type(email, { delay });
        log(`Entered email: ${email}`);

        const passwordInput = await page.waitForSelector(passwordSelector, {
            timeout: 5000,
            visible: true,
        });
        await passwordInput.click({ clickCount: 3 });
        await passwordInput.type(password, { delay });
        log("Entered password");

        await page.keyboard.press("Enter");
        log("Submitted GitHub login form");
    } catch (error) {
        log(`Error filling GitHub login form: ${error.message}`);
        throw error;
    }
}

async function clickGitHubAuthorizeButton(page, log, timeout = 15000) {
    log("Waiting for GitHub authorize button...");

    try {
        const authorizeBtn = await page.waitForSelector(
            "button[name=\"authorize\"][value=\"1\"]",
            { timeout, visible: true },
        );

        log("Clicking authorize button...");
        await authorizeBtn.click();
        await page.waitForNavigation({ waitUntil: "networkidle2" });
        log("Authorization complete");
    } catch (error) {
        log(`Error clicking GitHub authorize button: ${error.message}`);
        throw error;
    }
}

async function interceptOAuthCallback(page, callbackHostname, callbackPathPrefix, log) {
    log(`Setting up OAuth callback interception for ${callbackHostname}${callbackPathPrefix}...`);

    return new Promise((resolve, reject) => {
        let intercepted = false;

        const requestHandler = (request) => {
            try {
                const urlObj = new URL(request.url());

                if (urlObj.hostname === callbackHostname &&
                    urlObj.pathname.startsWith(callbackPathPrefix)) {

                    intercepted = true;
                    const code = urlObj.searchParams.get("code");
                    const state = urlObj.searchParams.get("state");

                    log(`Intercepted OAuth callback: code=${code?.substring(0, 10)}..., state=${state?.substring(0, 10)}...`);

                    request.abort();
                    page.removeListener("request", requestHandler);
                    resolve({ code, state });
                } else {
                    request.continue();
                }
            } catch (error) {
                request.continue();
            }
        };

        page.on("request", requestHandler);

        setTimeout(() => {
            if (!intercepted) {
                page.removeListener("request", requestHandler);
                reject(new Error("OAuth callback interception timeout"));
            }
        }, 120000);
    });
}

async function exchangeOAuthCallback(axiosInstance, baseUrl, exchangePath, code, state, originalState, cookies, log) {
    log("Exchanging OAuth callback for session...");

    validateOAuthState(state, originalState);

    const url = `${baseUrl}${exchangePath}?code=${code}&state=${state}`;

    try {
        const response = await axiosInstance.get(url, {
            headers: {
                "Accept": "application/json",
                "Cookie": cookies,
            },
            validateStatus: (status) => status < 500,
        });

        if (response.status !== 200) {
            throw new Error(`OAuth exchange failed: ${response.status} ${response.statusText}`);
        }

        const sessionCookie = extractSessionCookie(response);
        const userId = response.data?.user?.id || response.data?.data?.user?.id || response.data?.userId;

        if (!userId) {
            throw new Error("User ID not found in OAuth exchange response");
        }

        log(`OAuth exchange successful: userId=${userId}`);
        return { sessionCookie, userId };
    } catch (error) {
        log(`Error exchanging OAuth callback: ${error.message}`);
        throw error;
    }
}

function validateOAuthState(state, originalState) {
    if (state !== originalState) {
        throw new Error(`OAuth state mismatch: expected ${originalState}, got ${state}`);
    }
}

function extractSessionCookie(response, cookieName = "session") {
    const setCookieHeaders = response.headers["set-cookie"] || [];

    for (const cookieStr of setCookieHeaders) {
        const parts = cookieStr.split(";")[0].split("=");
        if (parts[0] === cookieName) {
            return `${parts[0]}=${parts[1]}`;
        }
    }

    throw new Error(`Session cookie '${cookieName}' not found in response`);
}

module.exports = {
    harvestOAuthState,
    buildGoogleOAuthUrl,
    buildGitHubOAuthUrl,
    fillGitHubLoginForm,
    clickGitHubAuthorizeButton,
    interceptOAuthCallback,
    exchangeOAuthCallback,
    validateOAuthState,
    extractSessionCookie,
};
