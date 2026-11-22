/**
 * GlobalShare Settings Module
 * 
 * @module lib/settings
 * @description
 * Centralisé application settings with persistence to localStorage.
 * This module provides a complete settings management system for GlobalShare,
 * including theme management, display options, notifications, behavior settings,
 * and advanced configurations.
 */

export interface AppSettings {
  // ============================================================================
  // Appearance Settings
  // ============================================================================
  
  /**
   * Theme preference for the application
   * - 'system': Follows the system color scheme preference
   * - 'light': Forces light theme
   * - 'dark': Forces dark theme
   */
  theme: 'system' | 'light' | 'dark';
  
  /**
   * Default language for the application
   * - 'fr': French (default)
   * - 'en': English
   * - 'es': Spanish
   * - 'de': German
   * - 'it': Italian
   */
  language: 'fr' | 'en' | 'es' | 'de' | 'it';
  
  /**
   * Accent color for UI elements (buttons, progress bars, etc.)
   * Format: HEX color code (e.g., '#a78bfa')
   */
  accentColor: string;
  
  // ============================================================================
  // Display Settings
  // ============================================================================
  
  /**
   * Whether to show file type icons in file lists
   * @default true
   */
  showFileIcons: boolean;
  
  /**
   * Whether to show file sizes in file lists
   * @default true
   */
  showFileSize: boolean;
  
  /**
   * Whether to show file dates (reception/modification) in file lists
   * @default true
   */
  showFileDate: boolean;
  
  /**
   * Whether to show the progress bar during transfers
   * @default true
   */
  showProgressBar: boolean;
  
  /**
   * Whether to show the connection status indicator
   * @default true
   */
  showConnectionStatus: boolean;
  
  /**
   * Number of items to display per page in lists
   * @default 50
   */
  itemsPerPage: number;
  
  // ============================================================================
  // Notification Settings
  // ============================================================================
  
  /**
   * Whether notifications are enabled
   * @default true
   */
  notificationsEnabled: boolean;
  
  /**
   * Whether to play a sound with notifications
   * @default true
   */
  notificationSound: boolean;
  
  /**
   * Duration in seconds for notification display
   * @default 5
   */
  notificationDuration: number;
  
  // ============================================================================
  // Behavior Settings
  // ============================================================================
  
  /**
   * Whether to automatically refresh the file list
   * @default true
   */
  autoRefresh: boolean;
  
  /**
   * Interval in seconds for automatic refresh
   * @default 30
   */
  autoRefreshInterval: number;
  
  /**
   * Whether to show confirmation dialog before deleting files
   * @default true
   */
  confirmDelete: boolean;
  
  /**
   * Whether to show confirmation dialog before overwriting files
   * @default true
   */
  confirmOverwrite: boolean;
  
  // ============================================================================
  // Advanced Settings
  // ============================================================================
  
  /**
   * Whether to enable folder compression when sending directories
   * @default true
   */
  enableCompression: boolean;
  
  /**
   * Maximum number of retry attempts for failed operations
   * @default 3
   */
  maxRetries: number;
  
  /**
   * Whether to enable debug mode (logs additional information)
   * @default false
   */
  debugMode: boolean;
}

// ============================================================================
// Default Settings
// ============================================================================

/**
 * Default application settings.
 * These values are used when no settings are saved or when resetting to defaults.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  // Appearance
  theme: 'system',
  language: 'fr',
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

// ============================================================================
// Storage Configuration
// ============================================================================

/**
 * Key used to store settings in localStorage
 */
const STORAGE_KEY = 'global-share-settings';

// ============================================================================
// Public Functions
// ============================================================================

/**
 * Load settings from localStorage, falling back to defaults.
 * 
 * @returns {AppSettings} The loaded settings or defaults if not found
 * 
 * @example
 * ```typescript
 * const settings = loadSettings();
 * console.log(settings.theme); // 'system', 'light', or 'dark'
 * ```
 */
export function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<AppSettings>;
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        // Ensure numeric values are valid
        itemsPerPage: Number.isFinite(parsed.itemsPerPage) ? parsed.itemsPerPage! : DEFAULT_SETTINGS.itemsPerPage,
        notificationDuration: Number.isFinite(parsed.notificationDuration) ? parsed.notificationDuration! : DEFAULT_SETTINGS.notificationDuration,
        autoRefreshInterval: Number.isFinite(parsed.autoRefreshInterval) ? parsed.autoRefreshInterval! : DEFAULT_SETTINGS.autoRefreshInterval,
        maxRetries: Number.isFinite(parsed.maxRetries) ? parsed.maxRetries! : DEFAULT_SETTINGS.maxRetries,
      };
    }
  } catch (error) {
    console.error('[Settings] Failed to load settings:', error);
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Save current settings to localStorage.
 * 
 * @param {AppSettings} settings - The settings to save
 * 
 * @example
 * ```typescript
 * const newSettings = { ...settings, theme: 'dark' };
 * saveSettings(newSettings);
 * ```
 */
export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.error('[Settings] Failed to save settings:', error);
  }
}

/**
 * Reset settings to defaults and save to localStorage.
 * 
 * @returns {AppSettings} The default settings
 * 
 * @example
 * ```typescript
 * const defaults = resetSettings();
 * console.log(defaults); // DEFAULT_SETTINGS
 * ```
 */
export function resetSettings(): AppSettings {
  const defaults = { ...DEFAULT_SETTINGS };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(defaults));
  } catch (error) {
    console.error('[Settings] Failed to reset settings:', error);
  }
  return defaults;
}

/**
 * Update a specific setting and automatically save to localStorage.
 * 
 * @template K - The key type of AppSettings
 * @param {AppSettings} current - Current settings
 * @param {K} key - The setting key to update
 * @param {AppSettings[K]} value - The new value
 * @returns {AppSettings} The updated settings
 * 
 * @example
 * ```typescript
 * const updated = updateSetting(settings, 'theme', 'dark');
 * // settings.theme is now 'dark' and saved to localStorage
 * ```
 */
export function updateSetting<K extends keyof AppSettings>(
  current: AppSettings,
  key: K,
  value: AppSettings[K]
): AppSettings {
  const updated = { ...current, [key]: value };
  saveSettings(updated);
  return updated;
}

/**
 * Get a specific setting value with type safety.
 * 
 * @template T - The key type of AppSettings
 * @param {AppSettings} settings - The settings object
 * @param {T} key - The setting key to retrieve
 * @returns {AppSettings[T]} The setting value
 * 
 * @example
 * ```typescript
 * const theme = getSetting(settings, 'theme'); // 'system' | 'light' | 'dark'
 * ```
 */
export function getSetting<T extends keyof AppSettings>(
  settings: AppSettings,
  key: T
): AppSettings[T] {
  return settings[key];
}

// ============================================================================
// Theme Application Helpers
// ============================================================================

/**
 * Apply theme to the document element.
 * This function should be called when theme settings change.
 * 
 * @param {'system' | 'light' | 'dark'} theme - The theme to apply
 * 
 * @example
 * ```typescript
 * applyTheme('dark');
 * // document now has gs-theme--dark class
 * ```
 */
export function applyTheme(theme: 'system' | 'light' | 'dark'): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;

  const html = document.documentElement;
  if (theme === 'system') {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    html.classList.toggle('gs-theme--light', !systemDark);
  } else {
    html.classList.toggle('gs-theme--light', theme === 'light');
  }
}

/**
 * Apply accent color to CSS variables.
 * 
 * @param {string} color - HEX color code
 * 
 * @example
 * ```typescript
 * applyAccentColor('#3b82f6');
 * // --gs-accent is now '#3b82f6'
 * ```
 */
export function applyAccentColor(color: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--gs-accent', color);
}

/**
 * Apply language to the HTML document.
 * 
 * @param {string} lang - Language code ('fr', 'en', 'es', 'de', 'it')
 * 
 * @example
 * ```typescript
 * applyLanguage('fr');
 * // <html lang="fr">
 * ```
 */
export function applyLanguage(lang: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
}
