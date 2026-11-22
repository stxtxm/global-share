/**
 * Settings Modal Component
 * 
 * @component Settings
 * @description
 * Provides a comprehensive settings interface for GlobalShare application.
 * This modal component allows users to configure all aspects of the application
 * including appearance, display options, notifications, behavior, and advanced settings.
 * 
 * @example
 * ```tsx
 * import Settings from './Settings';
 * 
 * function App() {
 *   const [settingsOpen, setSettingsOpen] = useState(false);
 *   
 *   return (
 *     <>
 *       <button onClick={() => setSettingsOpen(true)}>Open Settings</button>
 *       <Settings 
 *         isOpen={settingsOpen} 
 *         onClose={() => setSettingsOpen(false)} 
 *         setSettingsOpen={setSettingsOpen}
 *       />
 *     </>
 *   );
 * }
 * ```
 */

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { 
  loadSettings, 
  saveSettings, 
  resetSettings, 
  applyTheme,
  applyAccentColor,
  type AppSettings, 
  DEFAULT_SETTINGS 
} from '../lib/settings';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for the Settings component
 */
export interface SettingsProps {
  /**
   * Whether the settings modal is currently open
   */
  isOpen: boolean;
  
  /**
   * Callback function called when the user closes the settings modal
   */
  onClose: () => void;
  
  /**
   * State setter for controlling the settings modal visibility
   */
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
}

// ============================================================================
// Configuration Options
// ============================================================================

/**
 * Available theme options
 */
const THEMES = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Available accent color options
 */
const ACCENT_COLORS = [
  { value: '#a78bfa', label: 'Purple' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#10b981', label: 'Green' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
];

/**
 * Items per page options for display settings
 */
const ITEMS_PER_PAGE = [
  { value: 10, label: '10' },
  { value: 25, label: '25' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
  { value: 200, label: '200' },
];

/**
 * Auto-refresh interval options
 */
const REFRESH_INTERVALS = [
  { value: 10, label: '10s' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 120, label: '2m' },
  { value: 300, label: '5m' },
];

/**
 * Notification duration options
 */
const NOTIFICATION_DURATIONS = [
  { value: 2, label: '2s' },
  { value: 5, label: '5s' },
  { value: 8, label: '8s' },
  { value: 10, label: '10s' },
];

/**
 * Maximum retry options
 */
const MAX_RETRIES = [
  { value: 0, label: '0' },
  { value: 1, label: '1' },
  { value: 3, label: '3' },
  { value: 5, label: '5' },
  { value: 10, label: '10' },
];

// ============================================================================
// Component
// ============================================================================

/**
 * Settings modal component that provides a comprehensive configuration interface.
 * 
 * @param {SettingsProps} props - Component props
 * @returns {JSX.Element} The settings modal
 */
export function Settings({ isOpen, onClose, setSettingsOpen }: SettingsProps) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [tempSettings, setTempSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  // Load settings on mount
  useEffect(() => {
    // Différé : évite un setState synchrone dans le corps de l'effet
    // (rendu en cascade — règle eslint react-compiler).
    queueMicrotask(() => {
      const saved = loadSettings();
      setSettings(saved);
      setTempSettings(saved);
    });
  }, []);

  // Manage body overflow when modal is open
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      queueMicrotask(() => setIsClosing(false));
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Handle setting changes
  const handleChange = <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => {
    setTempSettings(prev => ({ ...prev, [key]: value }));
  };

  // Handle close with smooth animation
  const handleCloseWithAnimation = () => {
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, 280); // Match CSS animation duration (0.28s)
  };

  // Discard changes and close with animation
  const handleCancel = () => {
    setTempSettings(settings);
    handleCloseWithAnimation();
  };

  // Reset to defaults
  const handleReset = () => {
    const defaults = resetSettings();
    setSettings(defaults);
    setTempSettings(defaults);
  };

  // Save changes and apply to app with animation
  const handleSave = () => {
    saveSettings(tempSettings);
    setSettings(tempSettings);
    setIsClosing(true);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
      // Apply settings immediately after modal closes
      applySettingsToApp(tempSettings);
    }, 280);
  };

  /**
   * Apply settings changes to the application UI
   * 
   * @param {AppSettings} s - Settings to apply
   */
  const applySettingsToApp = (s: AppSettings) => {
    // Apply theme
    if (s.theme !== settings.theme) {
      applyTheme(s.theme);
    }
    // Apply accent color
    if (s.accentColor !== settings.accentColor) {
      applyAccentColor(s.accentColor);
    }
  };

  // Don't render if not open
  if (!isOpen && !isClosing) {
    return null;
  }

  // Combine animation classes
  const sheetClasses = `gs-sheet gs-sheet--settings${isClosing ? ' gs-sheet--closing' : ''}`;
  const overlayClasses = `gs-overlay${isClosing ? ' gs-overlay--closing' : ''}`;

  return (
    <div className={overlayClasses} onClick={(e) => { e.stopPropagation(); }}>
      <div className={sheetClasses} onClick={(e) => e.stopPropagation()}>
        {/* Sheet Handle */}
        <div className="gs-sheet-handle" aria-hidden="true" />
        
        {/* Header */}
        <div className="gs-sheet-header">
          <h2 className="gs-sheet-title">
            Settings
          </h2>
          <button 
            className="gs-btn gs-btn--icon gs-sheet-close"
            onClick={handleCancel}
            aria-label="Close settings"
            title="Close settings"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="gs-settings-content">
          
          {/* ================================================================ */}
          {/* Appearance Section */}
          {/* ================================================================ */}
          <section className="gs-settings-section">
            <h3 className="gs-settings-section-title">Appearance</h3>
            <div className="gs-settings-group">
              
              <div className="gs-settings-row">
                <label className="gs-settings-row-label">
                  <span>Theme</span>
                </label>
                <select
                  className="gs-select"
                  value={tempSettings.theme}
                  onChange={(e) => handleChange('theme', e.target.value as 'system' | 'light' | 'dark')}
                >
                  {THEMES.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="gs-settings-row">
                <label className="gs-settings-row-label">
                  <span>Accent Color</span>
                </label>
                <select
                  className="gs-select"
                  value={tempSettings.accentColor}
                  onChange={(e) => handleChange('accentColor', e.target.value)}
                >
                  {ACCENT_COLORS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              
            </div>
          </section>

          {/* ================================================================ */}
          {/* Display Section */}
          {/* ================================================================ */}
          <section className="gs-settings-section">
            <h3 className="gs-settings-section-title">Display</h3>
            <div className="gs-settings-group">
              
              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="showFileIcons"
                  checked={tempSettings.showFileIcons}
                  onChange={(e) => handleChange('showFileIcons', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="showFileIcons">
                  <span className="gs-settings-toggle-title">Show file icons</span>
                </label>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="showFileSize"
                  checked={tempSettings.showFileSize}
                  onChange={(e) => handleChange('showFileSize', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="showFileSize">
                  <span className="gs-settings-toggle-title">Show file sizes</span>
                </label>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="showFileDate"
                  checked={tempSettings.showFileDate}
                  onChange={(e) => handleChange('showFileDate', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="showFileDate">
                  <span className="gs-settings-toggle-title">Show file dates</span>
                </label>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="showProgressBar"
                  checked={tempSettings.showProgressBar}
                  onChange={(e) => handleChange('showProgressBar', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="showProgressBar">
                  <span className="gs-settings-toggle-title">Show progress bar</span>
                </label>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="showConnectionStatus"
                  checked={tempSettings.showConnectionStatus}
                  onChange={(e) => handleChange('showConnectionStatus', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="showConnectionStatus">
                  <span className="gs-settings-toggle-title">Show connection status</span>
                </label>
              </div>

              <div className="gs-settings-row">
                <label className="gs-settings-row-label">
                  <span>Items per page</span>
                  <span className="gs-settings-row-hint">{tempSettings.itemsPerPage}</span>
                </label>
                <select
                  className="gs-select"
                  value={tempSettings.itemsPerPage}
                  onChange={(e) => handleChange('itemsPerPage', Number(e.target.value))}
                >
                  {ITEMS_PER_PAGE.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              
            </div>
          </section>

          {/* ================================================================ */}
          {/* Notifications Section */}
          {/* ================================================================ */}
          <section className="gs-settings-section">
            <h3 className="gs-settings-section-title">Notifications</h3>
            <div className="gs-settings-group">
              
              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="notificationsEnabled"
                  checked={tempSettings.notificationsEnabled}
                  onChange={(e) => handleChange('notificationsEnabled', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="notificationsEnabled">
                  <span className="gs-settings-toggle-title">Enable notifications</span>
                </label>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="notificationSound"
                  checked={tempSettings.notificationSound}
                  onChange={(e) => handleChange('notificationSound', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="notificationSound">
                  <span className="gs-settings-toggle-title">Play notification sound</span>
                </label>
              </div>

              <div className="gs-settings-row">
                <label className="gs-settings-row-label">
                  <span>Notification duration</span>
                  <span className="gs-settings-row-hint">{tempSettings.notificationDuration}s</span>
                </label>
                <select
                  className="gs-select"
                  value={tempSettings.notificationDuration}
                  onChange={(e) => handleChange('notificationDuration', Number(e.target.value))}
                >
                  {NOTIFICATION_DURATIONS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              
            </div>
          </section>

          {/* ================================================================ */}
          {/* Behavior Section */}
          {/* ================================================================ */}
          <section className="gs-settings-section">
            <h3 className="gs-settings-section-title">Behavior</h3>
            <div className="gs-settings-group">
              
              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="autoRefresh"
                  checked={tempSettings.autoRefresh}
                  onChange={(e) => handleChange('autoRefresh', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="autoRefresh">
                  <span className="gs-settings-toggle-title">Auto-refresh file list</span>
                </label>
              </div>

              <div className="gs-settings-row">
                <label className="gs-settings-row-label">
                  <span>Auto-refresh interval</span>
                  <span className="gs-settings-row-hint">{tempSettings.autoRefreshInterval}s</span>
                </label>
                <select
                  className="gs-select"
                  value={tempSettings.autoRefreshInterval}
                  onChange={(e) => handleChange('autoRefreshInterval', Number(e.target.value))}
                  disabled={!tempSettings.autoRefresh}
                >
                  {REFRESH_INTERVALS.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="confirmDelete"
                  checked={tempSettings.confirmDelete}
                  onChange={(e) => handleChange('confirmDelete', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="confirmDelete">
                  <span className="gs-settings-toggle-title">Confirm before delete</span>
                </label>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="confirmOverwrite"
                  checked={tempSettings.confirmOverwrite}
                  onChange={(e) => handleChange('confirmOverwrite', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="confirmOverwrite">
                  <span className="gs-settings-toggle-title">Confirm before overwrite</span>
                </label>
              </div>
              
            </div>
          </section>

          {/* ================================================================ */}
          {/* Advanced Section */}
          {/* ================================================================ */}
          <section className="gs-settings-section">
            <h3 className="gs-settings-section-title">Advanced</h3>
            <div className="gs-settings-group">
              
              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="enableCompression"
                  checked={tempSettings.enableCompression}
                  onChange={(e) => handleChange('enableCompression', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="enableCompression">
                  <span className="gs-settings-toggle-title">Enable folder compression</span>
                </label>
              </div>

              <div className="gs-settings-row">
                <label className="gs-settings-row-label">
                  <span>Maximum retry attempts</span>
                  <span className="gs-settings-row-hint">{tempSettings.maxRetries}</span>
                </label>
                <select
                  className="gs-select"
                  value={tempSettings.maxRetries}
                  onChange={(e) => handleChange('maxRetries', Number(e.target.value))}
                >
                  {MAX_RETRIES.map(option => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="gs-settings-toggle">
                <input
                  type="checkbox"
                  id="debugMode"
                  checked={tempSettings.debugMode}
                  onChange={(e) => handleChange('debugMode', e.target.checked)}
                />
                <div className="gs-settings-toggle-slider" />
                <label className="gs-settings-toggle-label" htmlFor="debugMode">
                  <span className="gs-settings-toggle-title">Enable debug mode</span>
                </label>
              </div>
              
            </div>
          </section>

        </div>

        {/* Actions */}
        <div className="gs-sheet-actions">
          <button 
            className="gs-btn gs-btn--quiet" 
            onClick={handleReset}
          >
            Reset to defaults
          </button>
          <button 
            className="gs-btn gs-btn--quiet" 
            onClick={handleCancel}
          >
            Cancel
          </button>
          <button 
            className="gs-btn gs-btn--fill gs-btn--raised" 
            onClick={handleSave}
          >
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

export default Settings;
