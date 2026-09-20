// Regenerate redistribution notices from the exact installed dependencies.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const groups = JSON.parse(execSync('pnpm --dir desktop licenses list --prod --json', {
  cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 10 * 1024 * 1024,
}));
const packages = Object.values(groups).flat().map(p => ({
  name: p.name, version: p.versions.join(', '), license: p.license, directory: p.paths[0],
}));
for (const name of ['@fontsource/inter', '@fontsource/plus-jakarta-sans', 'material-symbols']) {
  const directory = path.join(root, 'website/node_modules', name);
  const p = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  packages.push({ name, version: p.version, license: p.license, directory });
}
const sections = ['# Third-party notices\n\nGenerated from installed dependencies. Each dependency retains its own license. Brand names and logos remain the property of their respective owners; these licenses do not grant trademark rights.\n\nElectron and Chromium notices are also distributed with the Windows application as LICENSE.electron.txt and LICENSES.chromium.html.'];
for (const p of packages.sort((a, b) => a.name.localeCompare(b.name))) {
  const files = fs.readdirSync(p.directory).filter(n => /^(licen[sc]e|copying|notice|ofl)([.-]|$)/i.test(n));
  if (!files.length) throw new Error(`Missing license text for ${p.name}`);
  sections.push(`## ${p.name} ${p.version}\n\nLicense: ${p.license}`);
  for (const file of files) {
    const full = path.join(p.directory, file);
    if (fs.statSync(full).isFile()) sections.push(`### ${file}\n\n${fs.readFileSync(full, 'utf8').trim()}`);
  }
}
const output = sections.join('\n\n---\n\n') + '\n';
fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), output);
fs.mkdirSync(path.join(root, 'website/public/licenses'), { recursive: true });
fs.writeFileSync(path.join(root, 'website/public/licenses/third-party-notices.txt'), output);
console.log(`Generated notices for ${packages.length} dependencies.`);
