import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'tracknext-consumer-'));
let passed = false;
try {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: root, encoding: 'utf8' }));
  assert.ok(packed.files.every(({ path }) => !path.startsWith('reference/') && !path.startsWith('tests/')));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(root, packed.filename)], { cwd: directory, stdio: 'pipe' });
  const metadata = JSON.parse(readFileSync(join(directory, 'node_modules/tracknext/package.json'), 'utf8'));
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0);
  // A fresh core consumer must not need Next.js. Then supply a consuming app's
  // installed Next.js for testing the adapter entry point against the CI matrix.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {createTracker} from 'tracknext/core';
    import {parseAttribution} from 'tracknext';
    const tracker=createTracker();
    const result=tracker.capture({url:'https://example.com/?utm_source=installed'});
    assert.equal(tracker.read(result.cookieValue)?.firstTouch.source,'installed');
    assert.equal(parseAttribution({url:'https://example.com/'}).kind,'direct');
    assert.throws(()=>import.meta.resolve('next/server.js'));
  `], { cwd: directory, stdio: 'inherit' });
  symlinkSync(join(root, 'node_modules/next'), join(directory, 'node_modules/next'), 'dir');
  writeFileSync(join(directory, 'consumer.ts'), `
    import {createAttribution, createStoredAttribution} from 'tracknext/next';
    import type {AttributionStore} from 'tracknext';
    import {NextRequest} from 'next/server.js';
    const tracker=createAttribution();
    const response=tracker.proxy(new NextRequest('https://example.com/?utm_source=installed',{headers:{accept:'text/html'}}));
    const source: string | undefined=tracker.read(response.cookies)?.firstTouch.source;
    const factory: (store: AttributionStore) => ReturnType<typeof createStoredAttribution> = (store) => createStoredAttribution({store});
    if(source!=='installed'||typeof factory!=='function') throw new Error('Installed adapter failed');
  `);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: directory, stdio: 'inherit' });
  execFileSync(process.execPath, ['--experimental-strip-types', 'consumer.ts'], { cwd: directory, stdio: 'inherit' });
  console.log(`Package consumer passed: ${packed.filename}; standalone core, Next.js adapter, and TypeScript declarations.`);
  passed = true;
} finally {
  if (passed) rmSync(directory, { recursive: true, force: true });
  else console.error(`Consumer test artifacts retained at ${directory}`);
}
