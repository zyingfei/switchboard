import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const bridgeKeyPath = (vaultPath) => join(vaultPath, '_BAC', '.config', 'bridge.key');
export const createBridgeKey = () => randomBytes(32).toString('base64url');
const ROTATION_GRACE_MS = 60_000;
const graceKeys = new Map();
export const ensureBridgeKey = async (vaultPath) => {
    const path = bridgeKeyPath(vaultPath);
    try {
        const existing = await readFile(path, 'utf8');
        const trimmed = existing.trim();
        if (trimmed.length > 0) {
            return { key: trimmed, path, created: false };
        }
    }
    catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
            throw error;
        }
    }
    const key = createBridgeKey();
    await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
    await writeFile(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
    return { key, path, created: true };
};
export const bridgeKeysMatch = (expected, actual) => {
    const expectedBuffer = Buffer.from(expected);
    const actualBuffer = Buffer.from(actual);
    return (expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer));
};
export const isBridgeKeyAccepted = async (vaultPath, expected, actual, now = new Date()) => {
    const matchesExpected = bridgeKeysMatch(expected, actual);
    if (matchesExpected) {
        return true;
    }
    for (const [key, expiresAt] of graceKeys) {
        if (expiresAt <= now.getTime()) {
            graceKeys.delete(key);
        }
        else if (bridgeKeysMatch(key, actual)) {
            return true;
        }
    }
    if (vaultPath === undefined) {
        return false;
    }
    try {
        const current = (await readFile(bridgeKeyPath(vaultPath), 'utf8')).trim();
        return current.length > 0 && bridgeKeysMatch(current, actual);
    }
    catch {
        return false;
    }
};
export const rotateBridgeKey = async (vaultPath, previousKey, now = new Date()) => {
    const current = createBridgeKey();
    await mkdir(join(vaultPath, '_BAC', '.config'), { recursive: true });
    await writeFile(bridgeKeyPath(vaultPath), `${current}\n`, { encoding: 'utf8', mode: 0o600 });
    // Keep the previous key alive briefly so in-flight browser requests do not
    // fail during a manual rotation.
    graceKeys.set(previousKey, now.getTime() + ROTATION_GRACE_MS);
    return { previous: previousKey, current, rotatedAt: now.toISOString() };
};
//# sourceMappingURL=bridgeKey.js.map