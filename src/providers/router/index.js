const { getConfig } = require('../../config');

class NineRouter {
    constructor(baseUrl, password, provider = null) {
        this.base = (baseUrl || '').replace(/\/$/, '');
        this.password = password || '';
        this.cookie = '';
        this.provider = provider;
    }

    async req(method, path, body = undefined) {
        if (!this.base) {
            throw new Error('ROUTER9_URL not configured');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
            const res = await fetch(`${this.base}${path}`, {
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.cookie ? { Cookie: this.cookie } : {}),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });

            const setCookieHeaders = res.headers.get('set-cookie');
            if (setCookieHeaders) {
                const cookieArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
                for (const raw of cookieArray) {
                    const part = String(raw).split(';')[0];
                    if (part.startsWith('auth_token=')) {
                        this.cookie = part;
                    }
                }
            }

            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                const err = new Error(data.error || `HTTP ${res.status}`);
                err.status = res.status;
                err.data = data;
                throw err;
            }
            return data;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async login() {
        try {
            const data = await this.req('POST', '/api/auth/login', { password: this.password });
            return !!data.success && !!this.cookie;
        } catch {
            return false;
        }
    }

    async listProviders() {
        const data = await this.req('GET', '/api/providers');
        return data.connections || data || [];
    }

    async deviceCode(provider = this.provider) {
        return this.req('GET', `/api/oauth/${provider}/device-code`);
    }

    async poll(deviceCode, codeVerifier, provider = this.provider) {
        try {
            const data = await this.req('POST', `/api/oauth/${provider}/poll`, {
                deviceCode,
                codeVerifier,
                extraData: null,
            });
            return {
                success: !!data.success,
                pending: !!data.pending,
                error: data.error,
                errorDescription: data.errorDescription,
                data,
            };
        } catch (e) {
            const d = e?.data;
            if (d && (d.pending || d.error === 'authorization_pending' || d.error === 'slow_down')) {
                return { success: false, pending: true, error: d.error };
            }
            return {
                success: false,
                pending: false,
                error: d?.error || e?.message || String(e),
            };
        }
    }

    async importProvider(provider, name, apiKey, extraData = {}, options = {}) {
        const body = {
            provider,
            name,
            apiKey,
            priority: options.priority ?? 1,
            proxyPoolId: options.proxyPoolId ?? null,
            testStatus: options.testStatus ?? 'active',
            ...extraData,
        };
        return this.req('POST', '/api/providers', body);
    }

    async importRefreshToken(provider, refreshToken) {
        return this.req('POST', `/api/oauth/${provider}/import`, { refreshToken });
    }

    async validateProvider(provider, apiKey, extraData = {}) {
        const body = {
            provider,
            apiKey,
            providerSpecificData: extraData,
        };
        return this.req('POST', '/api/providers/validate', body);
    }

    async ensureProviderNode(name, prefix, apiType, baseUrl, type) {
        const data = await this.req('GET', '/api/provider-nodes');
        const nodes = data.nodes || data;
        const existing = Array.isArray(nodes)
            ? nodes.find((n) => n.prefix === prefix)
            : null;
        if (existing) return existing.id;

        const created = await this.req('POST', '/api/provider-nodes', {
            name,
            prefix,
            apiType,
            baseUrl,
            type,
        });
        return created.id || created.node?.id;
    }
}

function expandSsoCookies(cookies) {
    const out = [];
    const seen = new Set();
    
    const push = (c) => {
        const clean = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            expires: typeof c.expires === 'number' && c.expires > 0 ? c.expires : -1,
            httpOnly: !!c.httpOnly,
            secure: c.secure !== false,
            session: !(typeof c.expires === 'number' && c.expires > 0),
            sameSite: c.sameSite || 'Lax',
        };
        
        if (!clean.domain || !clean.name) return;
        const key = `${clean.name}|${clean.domain}|${clean.path}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push(clean);
    };

    const authNames = /^(sso|sso-rw|x-userid)$/i;
    const isAuthDomain = (d) => {
        const x = d.toLowerCase().replace(/^\./, '');
        return x === 'grok.com' || x.endsWith('.grok.com') || 
               x === 'grokipedia.com' || x.endsWith('.grokipedia.com') ||
               x === 'x.ai' || x.endsWith('.x.ai');
    };

    for (const c of cookies) {
        if (!c.domain || !authNames.test(c.name)) continue;
        if (!isAuthDomain(c.domain)) continue;
        push(c);
    }

    const targets = ['.grok.com', '.grokipedia.com', '.x.ai', 'auth.x.ai', 'accounts.x.ai'];
    for (const c of [...out]) {
        for (const domain of targets) {
            push({
                ...c,
                domain,
                path: c.path || '/',
                secure: true,
                sameSite: c.sameSite === 'None' ? 'None' : 'Lax',
            });
        }
    }
    
    return out;
}

async function tryClickText(page, text, timeout = 5000) {
    const sels = [
        `button::-p-text(${text})`,
        `a::-p-text(${text})`,
        `[role="button"]::-p-text(${text})`,
        `::-p-text(${text})`,
    ];
    
    for (const sel of sels) {
        try {
            await page.locator(sel).setTimeout(timeout).click({ delay: 30 });
            return true;
        } catch {
        }
    }
    return false;
}

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clearBrowserCookies(browser) {
    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();
    const client = await page.createCDPSession();
    await client.send('Network.clearBrowserCookies');
}

async function addAccountToRouter(accountData, browser, log, provider = 'grok-cli') {
    const config = getConfig();
    const routerUrl = config.routerUrl || process.env.ROUTER9_URL || process.env.ROUTER_URL;
    const routerPass = config.routerPassword || process.env.ROUTER9_PASS || process.env.ROUTER_PASS || process.env.ROUTER_PASSWORD;

    if (!routerUrl || !routerPass) {
        log('[9Router] Not configured (missing ROUTER_URL and ROUTER_PASS), skipping');
        return { success: false, skipped: true, reason: 'not configured' };
    }

    log('[9Router] Starting OAuth device flow...');
    const r9 = new NineRouter(routerUrl, routerPass, provider);

    try {
        log('[9Router] Logging in...');
        if (!(await r9.login())) {
            log('[9Router] Login failed (wrong password?)');
            return { success: false, error: 'login failed' };
        }
        log('[9Router] Login success');
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[9Router] Unreachable: ${msg}`);
        return { success: false, error: 'unreachable', message: msg };
    }

    try {
        log('[9Router] Checking existing connections...');
        const conns = await r9.listProviders();
        const existing = new Set(
            conns
                .filter((c) => c.provider === provider)
                .map((c) => c.email)
                .filter(Boolean)
        );

        if (existing.has(accountData.email)) {
            log(`[9Router] ${accountData.email} already exists, skipping`);
            return { success: true, skipped: true, reason: 'already exists' };
        }
        log(`[9Router] ${existing.size} existing ${provider} connections`);
    } catch (e) {
        log(`[9Router] List providers error: ${e.message}`);
        return { success: false, error: 'list providers failed' };
    }

    try {
        log('[9Router] Clearing browser cookies...');
        await clearBrowserCookies(browser);
        
        const page = await browser.newPage();

        const cookies = expandSsoCookies(accountData.sso_cookies || []);
        const ssoCookies = cookies.filter((c) => /^(sso|sso-rw)$/i.test(c.name));
        
        if (!ssoCookies.length) {
            log('[9Router] No SSO cookies found in account data');
            await page.close();
            return { success: false, error: 'no sso cookies' };
        }
        
        log(`[9Router] Injecting ${cookies.length} cookies`);
        await page.setCookie(...cookies);

        log('[9Router] Getting device code...');
        const d = await r9.deviceCode();
        if (!d.device_code || !d.codeVerifier) {
            log('[9Router] Invalid device code response');
            await page.close();
            return { success: false, error: 'invalid device code' };
        }

        const userCode = d.user_code;
        const verifyUrl = d.verification_uri_complete || d.verification_uri;
        if (!verifyUrl) {
            log('[9Router] No verification URI');
            await page.close();
            return { success: false, error: 'no verification uri' };
        }
        
        log(`[9Router] User code: ${userCode}`);
        log(`[9Router] Opening: ${verifyUrl}`);

        await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(3000);

        const hasLoginInput = await page.evaluate(
            () => !!document.querySelector('input[type=email], input[type=password]')
        );
        if (hasLoginInput) {
            log('[9Router] SSO expired, login required');
            await page.close();
            return { success: false, error: 'sso expired' };
        }

        log('[9Router] Clicking Continue...');
        const clicked = await tryClickText(page, 'Continue', 5000);
        if (!clicked) {
            log('[9Router] Continue button not found');
            await page.close();
            return { success: false, error: 'continue button not found' };
        }
        await sleep(3000);

        log('[9Router] Clicking Allow...');
        if (await tryClickText(page, 'Allow', 8000)) {
            log('[9Router] Allow clicked');
        } else if (await tryClickText(page, 'Allow All', 3000)) {
            log('[9Router] Allow All clicked');
        } else {
            log('[9Router] Allow button not found');
            await page.close();
            return { success: false, error: 'allow button not found' };
        }
        
        await sleep(5000);
        
        try {
            const currentUrl = page.url();
            log(`[9Router] Post-consent URL: ${currentUrl}`);
        } catch {}
        
        await page.close().catch(() => undefined);

        log('[9Router] Polling for OAuth completion...');
        const maxAttempts = 60;
        for (let t = 0; t < maxAttempts; t++) {
            const res = await r9.poll(d.device_code, d.codeVerifier);
            if (res.success) {
                log('[9Router] Successfully added to 9router!');
                return { success: true, added: true };
            }
            if (!res.pending) {
                const errMsg = `${res.error}${res.errorDescription ? ` - ${res.errorDescription}` : ''}`;
                log(`[9Router] Poll error: ${errMsg}`);
                if (t === 0) {
                    log('[9Router] First poll failed, retrying in 10s...');
                    await sleep(10000);
                    continue;
                }
                return { success: false, error: 'poll error', message: errMsg };
            }
            if ((t + 1) % 10 === 0) {
                log(`[9Router] Polling... ${t + 1}/${maxAttempts} attempts`);
            }
        await sleep(3000);
        }
        
        log('[9Router] Poll timeout (5 minutes)');
        return { success: false, error: 'poll timeout' };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`[9Router] Error: ${msg}`);
        return { success: false, error: 'exception', message: msg };
    }
}

async function createRouter(provider = null, log = () => {}) {
    const config = getConfig();
    const routerUrl = config.routerUrl || process.env.ROUTER9_URL || process.env.ROUTER_URL;
    const routerPass = config.routerPassword || process.env.ROUTER9_PASS || process.env.ROUTER_PASS || process.env.ROUTER_PASSWORD;

    if (!routerUrl || !routerPass) {
        return { ok: false, error: 'not configured' };
    }

    const r9 = new NineRouter(routerUrl, routerPass, provider);
    if (!(await r9.login())) {
        return { ok: false, error: 'login failed' };
    }
    log('[9Router] Login success');
    return { ok: true, router: r9 };
}

module.exports = {
    NineRouter,
    createRouter,
    addAccountToRouter,
    expandSsoCookies,
};
