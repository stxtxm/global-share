# GlobalShare Settings Module Documentation

## 📋 Overview

This documentation describes the new **Settings Module** added to GlobalShare, which provides a comprehensive configuration system for the application. The module includes:

- **`app/lib/settings.ts`** - Core settings module with TypeScript interfaces and persistence
- **`app/components/Settings.tsx`** - React component for the settings UI
- **Updated `app/components/GlobalShare.tsx`** - Integration of settings into the main application
- **Updated `app/components/GlobalShare.css`** - Styles for the settings modal

## 🎯 Features

### 1. Settings Categories

The settings are organized into 5 logical sections:

#### 🎨 **Appearance**
- **Theme**: System / Light / Dark
- **Accent Color**: Purple, Pink, Blue, Green, Orange, Red

#### 👁️ **Display**
- Show file icons
- Show file sizes
- Show file dates
- Show progress bar
- Show connection status
- Items per page (10, 25, 50, 100, 200)

#### 🔔 **Notifications**
- Enable notifications
- Play notification sound
- Notification duration (2s, 5s, 8s, 10s)

#### 🔄 **Behavior**
- Auto-refresh file list
- Auto-refresh interval (10s, 30s, 1m, 2m, 5m)
- Confirm before delete
- Confirm before overwrite

#### ⚙️ **Advanced**
- Enable folder compression
- Maximum retry attempts (0, 1, 3, 5, 10)
- Enable debug mode

### 2. Key Features

- ✅ **Persistence**: All settings are saved to `localStorage`
- ✅ **Type Safety**: Full TypeScript support with `AppSettings` interface
- ✅ **Immediate Application**: Theme and accent color changes apply immediately
- ✅ **Reset Functionality**: Users can reset to default settings
- ✅ **Responsive Design**: Works on all screen sizes
- ✅ **Accessible**: Proper ARIA labels and keyboard navigation

## 🛠️ Installation & Usage

### Importing the Settings Module

```typescript
// Import the settings module
import { 
  loadSettings, 
  saveSettings, 
  resetSettings,
  updateSetting,
  getSetting,
  applyTheme,
  applyAccentColor,
  type AppSettings,
  DEFAULT_SETTINGS
} from '../lib/settings';
```

### Using in Components

```typescript
// Load settings
const settings = loadSettings();

// Update a setting
const updatedSettings = updateSetting(settings, 'theme', 'dark');

// Get a specific setting
const theme = getSetting(settings, 'theme');

// Apply theme to UI
applyTheme(settings.theme);

// Apply accent color
applyAccentColor(settings.accentColor);
```

### UI Integration

The Settings button is available in two locations:

1. **Desktop/Web (Tablet & Desktop)**: 
   - Located in the top-right corner of the header (topbar)
   - Hidden on mobile devices (< 768px width)

2. **Mobile (Android/iOS)**:
   - **Welcome Screen**: Located in the bottom navigation bar (4th item)
   - **Room Screen**: Located in the action bar (4th button alongside Fichier, Dossier, Photo)

This dual-placement ensures optimal accessibility:
- On mobile: Parameters are in the bottom bar (thumb zone)
- On desktop: Parameters are in the top bar (consistent with desktop UI patterns)

### Using the Settings Component

```tsx
import Settings from './Settings';

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  
  return (
    <>
      <button onClick={() => setSettingsOpen(true)}>
        Open Settings
      </button>
      
      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        setSettingsOpen={setSettingsOpen}
      />
    </>
  );
}
```

## 📦 API Reference

### `loadSettings()`

Load settings from localStorage, falling back to defaults.

**Returns:** `AppSettings`

**Example:**
```typescript
const settings = loadSettings();
```

---

### `saveSettings(settings: AppSettings)`

Save settings to localStorage.

**Parameters:**
- `settings`: The settings object to save

**Example:**
```typescript
saveSettings({ ...settings, theme: 'dark' });
```

---

### `resetSettings()`

Reset all settings to defaults and save to localStorage.

**Returns:** `AppSettings` - The default settings

**Example:**
```typescript
const defaults = resetSettings();
```

---

### `updateSetting<K extends keyof AppSettings>(current: AppSettings, key: K, value: AppSettings[K])`

Update a specific setting and automatically save to localStorage.

**Template Parameters:**
- `K`: The key type of AppSettings

**Parameters:**
- `current`: Current settings object
- `key`: The setting key to update
- `value`: The new value

**Returns:** `AppSettings` - The updated settings

**Example:**
```typescript
const updated = updateSetting(settings, 'theme', 'dark');
```

---

### `getSetting<T extends keyof AppSettings>(settings: AppSettings, key: T)`

Get a specific setting value with type safety.

**Template Parameters:**
- `T`: The key type of AppSettings

**Parameters:**
- `settings`: The settings object
- `key`: The setting key to retrieve

**Returns:** `AppSettings[T]` - The setting value

**Example:**
```typescript
const theme = getSetting(settings, 'theme');
```

---

### `applyTheme(theme: 'system' | 'light' | 'dark')`

Apply theme to the document element.

**Parameters:**
- `theme`: The theme to apply

**Example:**
```typescript
applyTheme('dark');
```

---

### `applyAccentColor(color: string)`

Apply accent color to CSS variables.

**Parameters:**
- `color`: HEX color code (e.g., '#a78bfa')

**Example:**
```typescript
applyAccentColor('#3b82f6');
```

## 🎨 CSS Variables & Styling

The settings module uses and can modify the following CSS variables:

```css
/* Theme variables */
--gs-theme: 'system' | 'light' | 'dark';

/* Accent colors */
--gs-accent: #a78bfa; /* Default purple */
--gs-accent-2: #8b5cf6; /* Secondary accent */

/* Theme-specific variables */
--gs-bg: #ffffff | #1a1a2e;
--gs-bg-soft: #f8fafc | #16213e;
--gs-surface: #ffffff | #0f172a;
--gs-surface-strong: #ffffff | #1e293b;
--gs-border: #e2e8f0 | #334155;
--gs-border-strong: #cbd5e1 | #475569;
--gs-text: #1e293b | #f1f5f9;
--gs-dim: #64748b | #94a3b8;
```

## 📁 File Structure

```
global-share/
├── app/
│   ├── lib/
│   │   └── settings.ts          # Core settings module
│   ├── components/
│   │   ├── Settings.tsx         # Settings modal component
│   │   └── GlobalShare.tsx      # Main app with settings integration
│   └── GlobalShare.css          # Styles including settings modal
└── SETTINGS_DOCUMENTATION.md    # This file
```

## 🔧 Default Settings

```typescript
const DEFAULT_SETTINGS: AppSettings = {
  // Appearance
  theme: 'system',
  accentColor: '#a78bfa',
  
  // Display
  showFileIcons: true,
  showFileSize: true,
  showFileDate: true,
  showProgressBar: true,
  showConnectionStatus: true,
  itemsPerPage: 50,
  
  // Notifications
  notificationsEnabled: true,
  notificationSound: true,
  notificationDuration: 5,
  
  // Behavior
  autoRefresh: true,
  autoRefreshInterval: 30,
  confirmDelete: true,
  confirmOverwrite: true,
  
  // Advanced
  enableCompression: true,
  maxRetries: 3,
  debugMode: false,
};
```

## 🎯 Integration with GlobalShare

The settings module is integrated into `GlobalShare.tsx` as follows:

1. **State Management**:
   ```typescript
   const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
   ```

2. **Initialization**:
   ```typescript
   useEffect(() => {
     const savedSettings = loadAppSettings();
     setAppSettings(savedSettings);
     applyThemeToApp(savedSettings.theme);
     if (savedSettings.accentColor !== DEFAULT_SETTINGS.accentColor) {
       document.documentElement.style.setProperty('--gs-accent', savedSettings.accentColor);
     }
   }, []);
   ```

3. **Settings Button**:
   Added to both welcome and room topbars:
   ```tsx
   <button
     type="button"
     className="gs-iconbtn"
     onClick={() => setSettingsOpen(true)}
     aria-label="Paramètres"
     title="Paramètres"
   >
     <IconSettings className="gs-icon" />
   </button>
   ```

4. **Settings Component**:
   Mounted in both views:
   ```tsx
   <Settings
     isOpen={settingsOpen}
     onClose={() => setSettingsOpen(false)}
     setSettingsOpen={setSettingsOpen}
   />
   ```

## 🧪 Testing

### Manual Testing Checklist

- [ ] **Opening Settings**: Click settings button in both welcome and room views
- [ ] **Closing Settings**: Click X button, Cancel button, or outside overlay
- [ ] **Theme Switching**: Change theme and verify UI updates immediately
- [ ] **Accent Color**: Change accent color and verify changes
- [ ] **Toggle Settings**: Enable/disable each toggle and verify persistence
- [ ] **Select Settings**: Change each select value and verify persistence
- [ ] **Reset to Defaults**: Click reset and verify all settings return to defaults
- [ ] **Save Changes**: Modify settings, save, close, and reopen to verify persistence
- [ ] **Page Refresh**: Refresh the page and verify settings persist
- [ ] **Browser Storage**: Check localStorage for `global-share-settings` key

### Automated Testing

To add automated tests, create test files in the `__tests__` directory:

```typescript
// __tests__/lib/settings.test.ts
import { 
  loadSettings, 
  saveSettings, 
  resetSettings,
  DEFAULT_SETTINGS 
} from '../../app/lib/settings';

describe('Settings Module', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('loadSettings returns defaults when empty', () => {
    const settings = loadSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  test('saveSettings and loadSettings work together', () => {
    const customSettings = { ...DEFAULT_SETTINGS, theme: 'dark' };
    saveSettings(customSettings);
    const loaded = loadSettings();
    expect(loaded.theme).toBe('dark');
  });

  test('resetSettings returns defaults', () => {
    const defaults = resetSettings();
    expect(defaults).toEqual(DEFAULT_SETTINGS);
  });
});
```

## 🐛 Troubleshooting

### Settings Not Persisting

**Problem**: Settings are reset after page refresh.

**Solution**: 
- Check if `localStorage` is available in your browser
- Verify that the settings are being saved with `saveSettings()`
- Check for errors in the browser console

### Theme Not Applying

**Problem**: Theme changes don't affect the UI.

**Solution**:
- Ensure `applyTheme()` is being called after settings change
- Verify that the CSS classes are being applied to the HTML element
- Check that the theme CSS variables are properly defined

### Accent Color Not Changing

**Problem**: Accent color changes don't affect the UI.

**Solution**:
- Ensure `applyAccentColor()` is being called
- Verify that the color is a valid HEX code
- Check that CSS variables are being used for accent colors

## 📝 Changelog

### v1.0.0 (Initial Release)

**Added:**
- Complete settings module with TypeScript interfaces
- Settings modal component with 5 sections
- 15+ configurable settings
- localStorage persistence
- Immediate theme and color application
- Full documentation

**Changed:**
- Updated GlobalShare.tsx to integrate settings
- Updated GlobalShare.css with settings modal styles
- Simplified and clarified UI text throughout the application

## 🎉 Contributing

To contribute to the settings module:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/awesome-settings`)
3. Make your changes
4. Add tests for new functionality
5. Update documentation
6. Commit your changes (`git commit -m 'Add awesome settings feature'`)
7. Push to the branch (`git push origin feature/awesome-settings`)
8. Open a Pull Request

## 📄 License

This settings module is part of GlobalShare and is licensed under the same license as the main project.

---

**Documentation Version**: 1.0.0  
**Last Updated**: 2024  
**Author**: GlobalShare Team
