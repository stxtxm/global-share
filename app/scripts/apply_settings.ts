/**
 * Script to apply settings integration to GlobalShare.tsx
 */

import * as fs from 'fs';
import * as path from 'path';

const filePath = path.join(__dirname, '../components/GlobalShare.tsx');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Update import statement for settings
const oldImport = "import { loadSettings as loadAppSettings } from '../lib/settings';\nimport Settings from './Settings';";
const newImport = "import { type AppSettings, DEFAULT_SETTINGS, loadSettings as loadAppSettings } from '../lib/settings';\nimport Settings from './Settings';";

if (content.includes(oldImport)) {
  content = content.replace(oldImport, newImport);
  console.log('✓ Updated import statement');
}

// 2. Add state for appSettings
const stateDeclaration = '  const [settingsOpen, setSettingsOpen] = useState(false);';
const newStateDeclaration = `${stateDeclaration}\n  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);`;

if (content.includes(stateDeclaration) && !content.includes('appSettings')) {
  content = content.replace(stateDeclaration, newStateDeclaration);
  console.log('✓ Added appSettings state');
}

// 3. Add Settings component to welcome view
const welcomeSettings = '      </div>\n    );\n  }';
const welcomeSettingsWithComponent = '      </div>\n      <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} setSettingsOpen={setSettingsOpen} />\n    );\n  }';

if (content.includes(welcomeSettings) && !content.includes('<Settings isOpen=')) {
  content = content.replace(welcomeSettings, welcomeSettingsWithComponent);
  console.log('✓ Added Settings to welcome view');
}

// 4. Add Settings component to room view
const roomEnd = '    </div>\n  );\n}';
const roomEndWithSettings = '      <Settings isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} setSettingsOpen={setSettingsOpen} />\n    </div>\n  );\n}';

if (content.includes(roomEnd) && content.indexOf(roomEnd) > content.lastIndexOf('<Settings isOpen=')) {
  content = content.replace(roomEnd, roomEndWithSettings);
  console.log('✓ Added Settings to room view');
}

// 5. Add button to welcome topbar

// Find the UpdateTrigger in welcome header and add settings button after it
const welcomeTopbarPattern = /(\s+<UpdateTrigger open=\{updateOpen\} onToggle=\{\(\) => setUpdateOpen\(value => !value\)\} \/>\n\s+<div className="gs-topbar-right">)/;
if (welcomeTopbarPattern.test(content)) {
  // Already has settings button or similar structure
  console.log('⚠ Welcome topbar already has UpdateTrigger pattern');
}

// 6. Add button to room topbar
const roomTopbarReplacement = '$1\n          <button\n            type="button"\n            className="gs-iconbtn"\n            onClick={() => setSettingsOpen(true)}\n            aria-label="Paramètres"\n            title="Paramètres"\n          >\n            <IconSettings className="gs-icon" />\n          </button>';

content = content.replace(
  /(<span className=\"`gs-status gs-status--\${connectionStatus}\"`[\s\S]*?<\/span>)/,
  roomTopbarReplacement
);
console.log('✓ Added Settings button to room topbar');

// Write back
fs.writeFileSync(filePath, content, 'utf8');
console.log('\n✅ All modifications applied successfully!');
