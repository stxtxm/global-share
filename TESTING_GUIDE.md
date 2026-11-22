# GlobalShare Settings Testing Guide

## 🧪 Testing Overview

This guide provides comprehensive testing instructions for the new Settings Module in GlobalShare. Testing should be performed on all supported platforms and browsers.

## 📋 Test Environments

### Supported Platforms
- ✅ **Web**: Chrome, Firefox, Safari, Edge (latest versions)
- ✅ **Desktop**: Windows, macOS, Linux (via Electron)
- ✅ **Mobile**: Android, iOS (via Capacitor)

### Browser Compatibility Matrix

| Browser | Minimum Version | Status |
|---------|-----------------|--------|
| Chrome | 90+ | ✅ Tested |
| Firefox | 88+ | ✅ Tested |
| Safari | 14+ | ✅ Tested |
| Edge | 90+ | ✅ Tested |
| Chrome Android | 90+ | ✅ Tested |
| Safari iOS | 14+ | ✅ Tested |

## 🚀 Pre-Test Setup

### 1. Build the Application

```bash
# Install dependencies
npm install

# Build for production
npm run build

# Start development server for manual testing
npm run dev
```

### 2. Test Data

Prepare test scenarios with different settings configurations:

```typescript
// Test configuration 1: Dark theme
const darkConfig = {
  theme: 'dark',
  accentColor: '#3b82f6',
  showFileIcons: true,
  notificationsEnabled: true
};

// Test configuration 2: Light theme with custom settings
const lightConfig = {
  theme: 'light',
  accentColor: '#10b981',
  showFileIcons: false,
  showFileSize: false,
  notificationsEnabled: false
};

// Test configuration 3: System theme
const systemConfig = {
  theme: 'system',
  accentColor: '#a78bfa',
  // All defaults
};
```

## 🧪 Test Cases

### 1. Settings Module Functionality

#### Test Case 1.1: Load Default Settings
- **Steps**: Open the application for the first time
- **Expected**: Settings should load with default values
- **Verification**: Check that all settings match `DEFAULT_SETTINGS`

#### Test Case 1.2: Save and Load Settings
- **Steps**: 
  1. Open Settings
  2. Change theme to 'dark'
  3. Change accent color to '#3b82f6'
  4. Disable 'showFileIcons'
  5. Save changes
  6. Close and reopen Settings
- **Expected**: Settings should persist with the changed values
- **Verification**: All settings should match the values set in step 2-4

#### Test Case 1.3: Reset to Defaults
- **Steps**: 
  1. Modify several settings
  2. Click "Reset to defaults"
  3. Save changes
- **Expected**: All settings should return to default values
- **Verification**: Compare with `DEFAULT_SETTINGS`

#### Test Case 1.4: Theme Application
- **Steps**: 
  1. Change theme to 'dark'
  2. Save changes
- **Expected**: UI should immediately change to dark theme
- **Verification**: 
  - HTML element should have `gs-theme--dark` class
  - Background colors should be dark
  - Text colors should be light

#### Test Case 1.5: Accent Color Application
- **Steps**: 
  1. Change accent color to '#ef4444' (Red)
  2. Save changes
- **Expected**: Accent colors should change throughout the UI
- **Verification**: 
  - Buttons should have red accent
  - Progress bars should be red
  - Other accent elements should be red

### 2. Settings UI Component

#### Test Case 2.1: Open Settings Modal
- **Steps**: Click settings button in topbar
- **Expected**: Settings modal should open from bottom
- **Verification**: 
  - Modal should be visible
  - Overlay should be semi-transparent
  - Modal should slide up with animation

#### Test Case 2.2: Close Settings Modal - X Button
- **Steps**: 
  1. Open Settings
  2. Click X button in top-right
- **Expected**: Settings modal should close
- **Verification**: Modal should disappear with animation

#### Test Case 2.3: Close Settings Modal - Cancel Button
- **Steps**: 
  1. Open Settings
  2. Make some changes
  3. Click "Cancel" button
- **Expected**: 
  - Settings modal should close
  - Changes should NOT be saved
- **Verification**: Reopen Settings and verify changes are not present

#### Test Case 2.4: Close Settings Modal - Overlay Click
- **Steps**: 
  1. Open Settings
  2. Click outside the modal (on the overlay)
- **Expected**: Settings modal should close
- **Verification**: Modal should disappear

#### Test Case 2.5: Toggle Settings
- **Steps**: 
  1. Open Settings
  2. Toggle "Show file icons" off and on
- **Expected**: 
  - Toggle should change state visually
  - Setting value should change in state
- **Verification**: 
  - Toggle slider should move
  - Check that internal state reflects the change

#### Test Case 2.6: Select Dropdowns
- **Steps**: 
  1. Open Settings
  2. Change theme select to 'dark'
  3. Change accent color to 'Blue'
  4. Change items per page to '100'
- **Expected**: 
  - Selected values should display correctly
  - Settings should update
- **Verification**: Check that dropdowns show the selected values

#### Test Case 2.7: Range Sliders (if applicable)
- **Steps**: 
  1. Open Settings
  2. Adjust notification duration slider
- **Expected**: 
  - Slider should move smoothly
  - Value should update
- **Verification**: Check that the value display updates with slider

#### Test Case 2.8: Section Navigation
- **Steps**: Scroll through all settings sections
- **Expected**: 
  - All sections should be visible
  - Section titles should be clear
  - Settings should be properly grouped
- **Verification**: Visual inspection of all 5 sections

### 3. Integration Tests

#### Test Case 3.1: Settings in Welcome View
- **Steps**: 
  1. Open application
  2. Click settings button in welcome topbar
- **Expected**: Settings modal should open
- **Verification**: Modal opens correctly

#### Test Case 3.2: Settings in Room View
- **Steps**: 
  1. Join a room
  2. Click settings button in room topbar
- **Expected**: Settings modal should open
- **Verification**: Modal opens correctly

#### Test Case 3.3: Settings Persistence Across Navigation
- **Steps**: 
  1. Open Settings in welcome view
  2. Change some settings and save
  3. Navigate to room view
  4. Open Settings again
- **Expected**: Settings should be the same as set in step 2
- **Verification**: All settings should persist

#### Test Case 3.4: Multiple Tabs
- **Steps**: 
  1. Open app in two browser tabs
  2. Change settings in tab 1
  3. Refresh tab 2
- **Expected**: Settings in tab 2 should match tab 1
- **Verification**: localStorage is shared between tabs

### 4. Edge Cases

#### Test Case 4.1: Rapid Settings Changes
- **Steps**: 
  1. Open Settings
  2. Rapidly change multiple settings
  3. Save changes
- **Expected**: All changes should be saved correctly
- **Verification**: Reopen and verify all changes are present

#### Test Case 4.2: Invalid Values
- **Steps**: 
  1. Manually edit localStorage to set invalid values
  2. Reload the application
- **Expected**: Invalid values should fall back to defaults
- **Verification**: Application should not crash, settings should be valid

#### Test Case 4.3: localStorage Full
- **Steps**: 
  1. Fill localStorage with other data
  2. Try to save settings
- **Expected**: Settings should save or show appropriate error
- **Verification**: Check browser console for errors

#### Test Case 4.4: Private/Incognito Mode
- **Steps**: 
  1. Open app in private/incognito window
  2. Change settings
  3. Close and reopen
- **Expected**: 
  - Settings may not persist (depends on browser)
  - Application should handle gracefully
- **Verification**: No errors should occur

#### Test Case 4.5: Offline Mode
- **Steps**: 
  1. Go offline
  2. Open Settings
  3. Change settings
  4. Go back online
  5. Reload application
- **Expected**: Settings should persist
- **Verification**: localStorage works offline

### 5. Platform-Specific Tests

#### Desktop (Electron)
- **Test Case 5.1**: Settings should work the same as web
- **Test Case 5.2**: Window controls should still work with settings modal open
- **Test Case 5.3**: Native menu integration (if applicable)

#### Mobile (Capacitor)
- **Test Case 5.4**: Settings modal should be touch-friendly
- **Test Case 5.5**: Modal should not be too large for screen
- **Test Case 5.6**: Touch targets should be large enough
- **Test Case 5.7**: Back button should close modal

#### Tablet
- **Test Case 5.8**: Modal should adapt to tablet screen sizes
- **Test Case 5.9**: All controls should be usable

## 📊 Test Results Template

```markdown
# Test Results - GlobalShare Settings

## Environment
- OS: [Windows/macOS/Linux/Android/iOS]
- Browser: [Chrome/Firefox/Safari/Edge]
- Version: [X.X.X]
- Date: [YYYY-MM-DD]
- Tester: [Name]

## Summary
- Total Tests: XX
- Passed: XX
- Failed: XX
- Skipped: XX
- Pass Rate: XX%

## Detailed Results

### Settings Module Functionality
- [ ] 1.1 Load Default Settings
- [ ] 1.2 Save and Load Settings
- [ ] 1.3 Reset to Defaults
- [ ] 1.4 Theme Application
- [ ] 1.5 Accent Color Application

### Settings UI Component
- [ ] 2.1 Open Settings Modal
- [ ] 2.2 Close Settings Modal - X Button
- [ ] 2.3 Close Settings Modal - Cancel Button
- [ ] 2.4 Close Settings Modal - Overlay Click
- [ ] 2.5 Toggle Settings
- [ ] 2.6 Select Dropdowns
- [ ] 2.7 Range Sliders
- [ ] 2.8 Section Navigation

### Integration Tests
- [ ] 3.1 Settings in Welcome View
- [ ] 3.2 Settings in Room View
- [ ] 3.3 Settings Persistence Across Navigation
- [ ] 3.4 Multiple Tabs

### Edge Cases
- [ ] 4.1 Rapid Settings Changes
- [ ] 4.2 Invalid Values
- [ ] 4.3 localStorage Full
- [ ] 4.4 Private/Incognito Mode
- [ ] 4.5 Offline Mode

### Platform-Specific Tests
- [ ] 5.1 Desktop - Settings Functionality
- [ ] 5.2 Desktop - Window Controls
- [ ] 5.3 Mobile - Touch Friendliness
- [ ] 5.4 Mobile - Screen Size
- [ ] 5.5 Mobile - Touch Targets
- [ ] 5.6 Mobile - Back Button
- [ ] 5.7 Tablet - Responsiveness
- [ ] 5.8 Tablet - Controls

## Issues Found

| # | Test Case | Description | Severity | Status |
|---|-----------|-------------|----------|--------|
| 1 | X.X | [Description] | [High/Medium/Low] | [Open/Fixed] |

## Notes

[Additional notes or observations]
```

## 🐛 Bug Reporting

If you find any bugs during testing, please report them with the following information:

1. **Steps to Reproduce**: Clear, detailed steps
2. **Expected Behavior**: What should happen
3. **Actual Behavior**: What actually happens
4. **Environment**: 
   - OS and version
   - Browser and version
   - Device (if mobile)
5. **Screenshots/Videos**: Visual proof if applicable
6. **Console Logs**: Any errors in browser console
7. **Severity**: High, Medium, or Low

## 📝 Automated Testing

### Running Automated Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- settings.test.ts

# Run with coverage
npm test -- --coverage
```

### Test Files to Create

1. `__tests__/lib/settings.test.ts` - Unit tests for settings module
2. `__tests__/components/Settings.test.tsx` - Component tests for Settings
3. `__tests__/integration/settings.integration.test.ts` - Integration tests

### Example Test File

```typescript
// __tests__/lib/settings.test.ts
import { 
  loadSettings, 
  saveSettings, 
  resetSettings,
  updateSetting,
  getSetting,
  DEFAULT_SETTINGS 
} from '../../app/lib/settings';

describe('Settings Module', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    // Mock localStorage if needed
    const localStorageMock = (() => {
      let store: Record<string, string> = {};
      return {
        getItem: jest.fn((key: string) => store[key] || null),
        setItem: jest.fn((key: string, value: string) => {
          store[key] = value;
        }),
        removeItem: jest.fn((key: string) => {
          delete store[key];
        }),
        clear: jest.fn(() => {
          store = {};
        }),
      };
    })();
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
    });
  });

  describe('loadSettings', () => {
    test('returns defaults when localStorage is empty', () => {
      const settings = loadSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });

    test('returns saved settings when available', () => {
      const customSettings = { ...DEFAULT_SETTINGS, theme: 'dark' };
      localStorage.setItem('global-share-settings', JSON.stringify(customSettings));
      
      const settings = loadSettings();
      expect(settings.theme).toBe('dark');
    });

    test('handles invalid JSON gracefully', () => {
      localStorage.setItem('global-share-settings', 'invalid json');
      
      const settings = loadSettings();
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });
  });

  describe('saveSettings', () => {
    test('saves settings to localStorage', () => {
      const settings = { ...DEFAULT_SETTINGS, theme: 'light' };
      saveSettings(settings);
      
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'global-share-settings',
        JSON.stringify(settings)
      );
    });
  });

  describe('resetSettings', () => {
    test('returns defaults and clears localStorage', () => {
      const defaults = resetSettings();
      expect(defaults).toEqual(DEFAULT_SETTINGS);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'global-share-settings',
        JSON.stringify(DEFAULT_SETTINGS)
      );
    });
  });

  describe('updateSetting', () => {
    test('updates a specific setting', () => {
      const current = { ...DEFAULT_SETTINGS };
      const updated = updateSetting(current, 'theme', 'dark');
      
      expect(updated.theme).toBe('dark');
      expect(updated.showFileIcons).toBe(true); // Other settings unchanged
    });

    test('saves to localStorage', () => {
      const current = { ...DEFAULT_SETTINGS };
      updateSetting(current, 'theme', 'dark');
      
      expect(localStorage.setItem).toHaveBeenCalled();
    });
  });

  describe('getSetting', () => {
    test('returns the correct setting value', () => {
      const settings = { ...DEFAULT_SETTINGS, theme: 'dark' };
      const theme = getSetting(settings, 'theme');
      
      expect(theme).toBe('dark');
    });
  });
});
```

## ✅ Test Sign-Off

Before releasing, ensure all tests are completed and signed off:

```
□ All manual tests passed
□ Automated tests created and passing
□ Cross-browser testing completed
□ Cross-platform testing completed
□ Edge cases handled
□ Performance acceptable
□ Accessibility verified
□ Security review completed
□ Documentation updated
□ Code review completed
```

---

**Testing Guide Version**: 1.0.0  
**Last Updated**: 2024  
**Author**: GlobalShare Team
