/**
 * Auto-update checker for memo-agent.
 * Checks npm registry for newer versions and displays update notifications.
 */

import { createRequire } from 'node:module';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';

export type UpdateChoice = 'update' | 'skip' | 'skip_forever' | null;

interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

interface NpmRegistryResponse {
  'dist-tags': {
    latest: string;
    [key: string]: string;
  };
  versions: Record<string, unknown>;
}

const PACKAGE_NAME = 'memo-agent';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

function getCacheFile(): string {
  const home = os.homedir();
  const dir = path.join(home, '.memo-agent');
  // Ensure directory exists silently
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return path.join(dir, '.update-check');
}

function readCurrentVersion(): string {
  const _require = createRequire(import.meta.url);
  return (_require('../../package.json') as { version: string }).version;
}

async function fetchNpmRegistry(): Promise<NpmRegistryResponse> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'registry.npmjs.org',
      path: `/${PACKAGE_NAME}`,
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': `memo-agent/${readCurrentVersion()}`
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as NpmRegistryResponse;
          resolve(json);
        } catch {
          reject(new Error('Failed to parse npm registry response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.end();
  });
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, '').split('.').map(Number);
}

function compareVersions(v1: string, v2: string): number {
  const a = parseVersion(v1);
  const b = parseVersion(v2);
  const len = Math.max(a.length, b.length);

  for (let i = 0; i < len; i++) {
    const numA = a[i] ?? 0;
    const numB = b[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

function shouldCheckCache(): boolean {
  try {
    const cacheFile = getCacheFile();
    if (!fs.existsSync(cacheFile)) return true;

    const stat = fs.statSync(cacheFile);
    const ageMs = Date.now() - stat.mtime.getTime();
    return ageMs > CHECK_INTERVAL_MS;
  } catch {
    return true;
  }
}

function writeCache(info: VersionInfo): void {
  try {
    const cacheFile = getCacheFile();
    fs.writeFileSync(cacheFile, JSON.stringify(info), 'utf-8');
  } catch {
    // Ignore cache write errors
  }
}

function readCache(): VersionInfo | null {
  try {
    const cacheFile = getCacheFile();
    const content = fs.readFileSync(cacheFile, 'utf-8');
    return JSON.parse(content) as VersionInfo;
  } catch {
    return null;
  }
}

/**
 * Checks if an update is available.
 * Respects cache to avoid excessive network requests (checked once per day).
 * Returns null if check fails or is skipped.
 */
export async function checkForUpdate(
  force = false
): Promise<VersionInfo | null> {
  const current = readCurrentVersion();

  // Use cache if available and not forcing
  if (!force && !shouldCheckCache()) {
    const cached = readCache();
    if (cached && cached.current === current) {
      return cached.hasUpdate ? cached : null;
    }
  }

  try {
    const registry = await fetchNpmRegistry();
    const latest = registry['dist-tags'].latest;

    const hasUpdate = compareVersions(latest, current) > 0;
    const info: VersionInfo = { current, latest, hasUpdate };

    writeCache(info);

    return hasUpdate ? info : null;
  } catch {
    // Silently fail - don't interrupt user experience
    return null;
  }
}

/**
 * Formats an update notification message.
 */
export function formatUpdateMessage(info: VersionInfo): string {
  return `
┌─────────────────────────────────────────┐
│  Update available: ${info.current} → ${info.latest.padEnd(9)} │
│                                         │
│  [1] Update now                         │
│  [2] Skip this update                   │
│  [3] Skip and don't remind again        │
└─────────────────────────────────────────┘
`;
}

/**
 * Performs the update by running npm install.
 * Returns true if successful.
 */
export async function performUpdate(): Promise<boolean> {
  const { spawn } = await import('node:child_process');

  return new Promise((resolve) => {
    const proc = spawn('npm', ['install', '-g', PACKAGE_NAME], {
      stdio: 'inherit',
      shell: true
    });

    proc.on('close', (code) => {
      resolve(code === 0);
    });

    proc.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Reads a single key from stdin without requiring Enter press.
 * Returns null if stdin is not a TTY.
 */
function readKey(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(null);
      return;
    }

    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (key: string) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve(key);
    };

    stdin.once('data', onData);
  });
}

const SKIP_FOREVER_FILE = '.skip-update';

function getSkipForeverFile(): string {
  const home = os.homedir();
  const dir = path.join(home, '.memo-agent');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return path.join(dir, SKIP_FOREVER_FILE);
}

/**
 * Checks if user has chosen to skip all future update reminders.
 */
export function isSkipForever(): boolean {
  try {
    return fs.existsSync(getSkipForeverFile());
  } catch {
    return false;
  }
}

/**
 * Marks updates to be permanently skipped.
 */
export function setSkipForever(skip: boolean): void {
  try {
    const file = getSkipForeverFile();
    if (skip) {
      fs.writeFileSync(file, '', 'utf-8');
    } else {
      fs.unlinkSync(file);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Prompts user for update choice and handles the interaction.
 * Returns the user's choice.
 */
export async function promptForUpdate(
  info: VersionInfo
): Promise<UpdateChoice> {
  // Write message to stderr to not interfere with potential stdout redirection
  process.stderr.write(formatUpdateMessage(info));
  process.stderr.write('\nChoice: ');

  const key = await readKey();

  if (key === null) {
    return null; // Non-TTY environment
  }

  process.stderr.write('\n');

  switch (key) {
    case '1':
      return 'update';
    case '2':
      return 'skip';
    case '3':
      setSkipForever(true);
      process.stderr.write('Future update reminders disabled.\n');
      return 'skip_forever';
    default:
      // Invalid input defaults to skip
      return 'skip';
  }
}

/**
 * Handles the complete update flow: check, prompt, and optionally perform update.
 * Returns true if the app should restart, false otherwise.
 */
export async function handleUpdateCheck(force = false): Promise<boolean> {
  // Skip if user has disabled reminders
  if (!force && isSkipForever()) {
    return false;
  }

  const info = await checkForUpdate(force);
  if (!info) {
    return false;
  }

  const choice = await promptForUpdate(info);

  if (choice === 'update') {
    process.stderr.write('\nInstalling update...\n');
    const success = await performUpdate();

    if (success) {
      process.stderr.write('\n✓ Update installed successfully!\n');
      process.stderr.write(
        'Please restart memo-agent to use the new version.\n'
      );
      return true; // Signal to exit
    } else {
      process.stderr.write('\n✗ Update failed. Please try manually:\n');
      process.stderr.write('  npm install -g memo-agent\n\n');
      return false;
    }
  }

  return false;
}
