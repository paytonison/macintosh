import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = require('electron');

const APP_NAME = 'The Macintosh';
const APP_BUNDLE_ID = 'com.paytonison.themacintosh';
const RUNTIME_FORMAT_VERSION = 2;

const replacePlistString = async (plistPath, key, value) => {
  await execFileAsync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath]);
};

const createRuntimeFingerprint = async (sourcePlist, iconPath) => {
  const [sourcePlistStats, iconStats] = await Promise.all([stat(sourcePlist), stat(iconPath)]);
  return JSON.stringify({
    runtimeFormatVersion: RUNTIME_FORMAT_VERSION,
    electronExecutable,
    sourcePlistSize: sourcePlistStats.size,
    sourcePlistModifiedAt: sourcePlistStats.mtimeMs,
    iconSize: iconStats.size,
    iconModifiedAt: iconStats.mtimeMs,
  });
};

const hasCurrentRuntime = async (markerPath, runtimeExecutable, fingerprint) => {
  try {
    const [savedFingerprint] = await Promise.all([
      readFile(markerPath, 'utf8'),
      stat(runtimeExecutable),
    ]);
    return savedFingerprint === fingerprint;
  } catch {
    return false;
  }
};

export const getBrandedElectronExecutable = async () => {
  if (process.platform !== 'darwin') return electronExecutable;

  const sourceApp = path.resolve(path.dirname(electronExecutable), '../..');
  const sourcePlist = path.join(sourceApp, 'Contents', 'Info.plist');
  const runtimeRoot = path.join(projectRoot, 'dist', 'runtime');
  const runtimeApp = path.join(runtimeRoot, `${APP_NAME}.app`);
  const runtimeExecutable = path.join(runtimeApp, 'Contents', 'MacOS', 'Electron');
  const runtimePlist = path.join(runtimeApp, 'Contents', 'Info.plist');
  const markerPath = path.join(runtimeRoot, 'the-macintosh-runtime.json');
  const iconPath = path.join(projectRoot, 'assets', 'the-macintosh.icns');
  const fingerprint = await createRuntimeFingerprint(sourcePlist, iconPath);

  if (await hasCurrentRuntime(markerPath, runtimeExecutable, fingerprint)) {
    return runtimeExecutable;
  }

  await mkdir(runtimeRoot, { recursive: true });
  await rm(runtimeApp, { recursive: true, force: true });
  await rm(markerPath, { force: true });
  await execFileAsync('/bin/cp', ['-cR', sourceApp, runtimeApp]);

  await replacePlistString(runtimePlist, 'CFBundleDisplayName', APP_NAME);
  await replacePlistString(runtimePlist, 'CFBundleName', APP_NAME);
  await replacePlistString(runtimePlist, 'CFBundleIdentifier', APP_BUNDLE_ID);
  await copyFile(iconPath, path.join(runtimeApp, 'Contents', 'Resources', 'the-macintosh.icns'));
  await replacePlistString(runtimePlist, 'CFBundleIconFile', 'the-macintosh.icns');

  await execFileAsync('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    '--timestamp=none',
    runtimeApp,
  ]);
  // Electron's downloaded framework is linker-signed and does not pass a recursive
  // resource-seal check even before branding. Verify the outer bundle we modify.
  await execFileAsync('/usr/bin/codesign', ['--verify', runtimeApp]);
  await writeFile(markerPath, fingerprint, 'utf8');

  return runtimeExecutable;
};

export { projectRoot };
