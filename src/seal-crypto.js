const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ALG = 'aes-256-gcm';

function parseKeyB64(keyB64) {
    const key = Buffer.from(keyB64.trim(), 'base64');
    if (key.length !== 32) {
        throw new Error(`SEAL key must be 32 bytes (base64), got ${key.length}`);
    }
    return key;
}

function generateKeyB64() {
    return randomBytes(32).toString('base64');
}

function sealUtf8(plain, key, kid = 'default') {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALG, key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        v: 1,
        alg: 'AES-256-GCM',
        kid,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ct: ct.toString('base64'),
    };
}

function unsealUtf8(blob, key) {
    if (blob.v !== 1 || blob.alg !== 'AES-256-GCM') {
        throw new Error(`unsupported sealed format v=${blob.v} alg=${blob.alg}`);
    }
    const iv = Buffer.from(blob.iv, 'base64');
    const tag = Buffer.from(blob.tag, 'base64');
    const ct = Buffer.from(blob.ct, 'base64');
    if (iv.length !== 12) throw new Error('bad iv length');
    if (tag.length !== 16) throw new Error('bad tag length');
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function parseSealedJson(raw) {
    const blob = JSON.parse(raw);
    if (!blob || blob.v !== 1 || !blob.iv || !blob.tag || !blob.ct) {
        throw new Error('invalid sealed JSON');
    }
    return blob;
}

module.exports = {
    parseKeyB64,
    generateKeyB64,
    sealUtf8,
    unsealUtf8,
    parseSealedJson,
};
