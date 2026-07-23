const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { getConfig } = require('./config');
const { parseKeyB64, parseSealedJson, unsealUtf8 } = require('./seal-crypto');

const PROJECT_ROOT = join(__dirname, '..');
const ENC_DIR = join(PROJECT_ROOT, 'turnstile');

const temps = new Set();

function trackTemp(dir) {
    temps.add(dir);
    return dir;
}

function cleanupSealedTemps() {
    for (const dir of temps) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
        }
    }
    temps.clear();
}

let hooksInstalled = false;
function installExitHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    const bye = () => cleanupSealedTemps();
    process.once('exit', bye);
    process.once('SIGINT', () => {
        bye();
        process.exit(130);
    });
    process.once('SIGTERM', () => {
        bye();
        process.exit(143);
    });
}

function materializeExt(scriptJs) {
    const manifestPath = join(ENC_DIR, 'manifest.json');
    if (!existsSync(manifestPath)) {
        throw new Error(`missing ${manifestPath}`);
    }
    const dir = trackTemp(mkdtempSync(join(tmpdir(), 'grok-turnstile-')));
    writeFileSync(join(dir, 'script.js'), scriptJs, 'utf8');
    writeFileSync(join(dir, 'manifest.json'), readFileSync(manifestPath));
    installExitHooks();
    return dir;
}

async function fetchUnlockKey(kid) {
    const config = getConfig();
    const urlBase = config.sealUnlockUrl || process.env.SEAL_UNLOCK_URL;
    if (!urlBase) {
        throw new Error(
            'sealed extension needs SEAL_UNLOCK_URL in .env (or local SEAL_KEY / plain turnstile/script.js)'
        );
    }
    const token = config.sealToken || process.env.SEAL_TOKEN;
    const u = new URL(urlBase);
    u.searchParams.set('kid', kid);
    u.searchParams.set('app', 'bercocok-tanam-grok');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
        const res = await fetch(u, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: controller.signal,
        });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`unlock HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
        }

        const data = await res.json();
        if (!data?.key) throw new Error('unlock response missing key');
        return data.key;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function resolveKey(blob) {
    const config = getConfig();
    const local = config.sealKey || process.env.SEAL_KEY;
    if (local) return parseKeyB64(local);
    const remote = await fetchUnlockKey(blob.kid || 'default');
    return parseKeyB64(remote);
}

async function resolveTurnstileExt() {
    const config = getConfig();
    const override = config.turnstileExtPath || process.env.TURNSTILE_EXT_PATH;
    if (override) {
        const script = join(override, 'script.js');
        const manifest = join(override, 'manifest.json');
        if (!existsSync(script) || !existsSync(manifest)) {
            throw new Error(`TURNSTILE_EXT_PATH missing script.js/manifest.json: ${override}`);
        }
        return override;
    }

    const plain = join(ENC_DIR, 'script.js');
    const manifest = join(ENC_DIR, 'manifest.json');
    if (existsSync(plain) && existsSync(manifest)) {
        return ENC_DIR;
    }

    const sealedPath = join(ENC_DIR, 'script.sealed');
    if (!existsSync(sealedPath) || !existsSync(manifest)) {
        throw new Error(
            `missing turnstile assets (need script.js or script.sealed + manifest.json in ${ENC_DIR})`
        );
    }

    const blob = parseSealedJson(readFileSync(sealedPath, 'utf8'));
    const key = await resolveKey(blob);
    const scriptJs = unsealUtf8(blob, key);
    return materializeExt(scriptJs);
}

function ensureEncDir() {
    mkdirSync(ENC_DIR, { recursive: true });
}

module.exports = {
    resolveTurnstileExt,
    cleanupSealedTemps,
    ensureEncDir,
};
