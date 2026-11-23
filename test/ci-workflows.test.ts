// La CI est du code : ces invariants évitent de réintroduire un pipeline
// séquentiel, une installation sans cache ou un déploiement documentaire.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

const deploy = read('.github/workflows/deploy.yml');
const release = read('.github/workflows/release.yml');
const android = read('.github/workflows/android.yml');

function job(workflow: string, name: string): string {
  const match = new RegExp(
    `(?:^|\\n)  ${name}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|$)`
  ).exec(workflow);
  assert.ok(match, `job « ${name} » introuvable`);
  return match[1];
}

test('les pushes purement documentaires ne déclenchent pas Pages', () => {
  assert.match(deploy, /paths-ignore:/);
  assert.match(deploy, /- '\*\*\/\*\.md'/);
  assert.match(deploy, /- 'docs\/\*\*'/);
  assert.match(deploy, /- 'LICENSE'/);
});

test('worker, test et build démarrent ensemble puis deploy attend les trois', () => {
  const build = job(deploy, 'build');
  const deployJob = job(deploy, 'deploy');

  assert.doesNotMatch(build, /^    needs:/m, 'build ne doit dépendre ni du worker ni des tests');
  assert.match(deployJob, /needs: \[build, test, worker\]/);
  assert.match(deployJob, /always\(\)/);
  assert.match(deployJob, /needs\.build\.result == 'success'/);
  assert.match(deployJob, /needs\.test\.result == 'success'/);
  assert.match(deployJob, /needs\.worker\.result != 'cancelled'/);
});

test('le worker utilise le cache npm et le wrangler verrouillé du lockfile', () => {
  const worker = job(deploy, 'worker');
  assert.match(worker, /cache-dependency-path: socket-server-cloudflare\/package-lock\.json/);
  assert.match(worker, /npm ci --no-audit --no-fund/);
  assert.match(worker, /npx --no-install wrangler/);
  assert.doesNotMatch(worker, /npx --yes wrangler/);
});

test('lint et typecheck sont dans le job de tests, pas sur le chemin du build', () => {
  const testJob = job(deploy, 'test');
  const build = job(deploy, 'build');

  assert.match(testJob, /npm run test:unit/);
  assert.match(testJob, /npm run lint/);
  assert.match(testJob, /npx tsc --noEmit/);
  assert.doesNotMatch(build, /npm run lint/);
  assert.doesNotMatch(build, /npx tsc --noEmit/);
});

test('le build Pages réutilise le cache Next.js', () => {
  const build = job(deploy, 'build');
  assert.match(build, /actions\/cache@v6/);
  assert.match(build, /path: \.next\/cache/);
  assert.match(build, /key: next-\$\{\{ runner\.os \}\}/);
});

test('la release desktop met en cache npm, Electron et Next.js', () => {
  assert.match(release, /cache-dependency-path: \|\n\s+package-lock\.json\n\s+desktop\/package-lock\.json/);
  assert.match(release, /name: Cache Electron downloads \(Linux\)/);
  assert.match(release, /name: Cache Electron downloads \(Windows\)/);
  assert.match(release, /path: \.next\/cache/);
  assert.match(release, /npm --prefix desktop ci --no-audit --no-fund/);
});

test('Android réutilise Gradle et ne réinstalle le SDK que s il manque', () => {
  assert.match(android, /gradle\/actions\/setup-gradle@v6/);
  assert.match(android, /if \[ -d "\$SDK_ROOT\/platforms\/android-36" \]/);
  assert.match(android, /build-tools\/36\.0\.0/);
  assert.match(android, /npm ci --no-audit --no-fund/);
});

test('le test CI fait partie de la suite unitaire', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['test:unit'], /test\/ci-workflows\.test\.ts/);
});
