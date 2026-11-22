/**
 * Settings Page
 * 
 * @page Settings
 * @description
 * Full-page settings interface for GlobalShare application.
 * This page allows users to configure all aspects of the application
 * including appearance, display options, notifications, behavior, and advanced settings.
 */

'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import './page.css';
import { 
  loadSettings, 
  saveSettings, 
  resetSettings,
  applyTheme,
  applyAccentColor,
  applyLanguage,
  type AppSettings, 
  DEFAULT_SETTINGS 
} from '../lib/settings';

// ============================================================================
// Translations
// ============================================================================

const TRANSLATIONS: Record<string, Record<string, string>> = {
  fr: {
    // Header
    settings: 'Paramètres',
    back: 'Retour',
    save: 'Sauvegarder',
    reset: 'Réinitialiser',
    
    // Categories
    appearance: 'Apparence',
    display: 'Affichage',
    notifications: 'Notifications',
    behavior: 'Comportement',
    advanced: 'Avancé',
    
    // Appearance
    theme: 'Thème',
    themeSystem: 'Système',
    themeLight: 'Clair',
    themeDark: 'Sombre',
    language: 'Langue',
    accentColor: 'Couleur d\'accent',
    
    // Display
    showFileIcons: 'Afficher les icônes de fichiers',
    showFileSize: 'Afficher la taille des fichiers',
    showFileDate: 'Afficher la date des fichiers',
    showProgressBar: 'Afficher la barre de progression',
    showConnectionStatus: 'Afficher le statut de connexion',
    itemsPerPage: 'Éléments par page',
    
    // Notifications
    notificationsEnabled: 'Notifications activées',
    notificationSound: 'Son des notifications',
    notificationDuration: 'Durée des notifications (secondes)',
    
    // Behavior
    autoRefresh: 'Rafraîchissement automatique',
    autoRefreshInterval: 'Intervalle de rafraîchissement (secondes)',
    confirmDelete: 'Confirmer avant suppression',
    confirmOverwrite: 'Confirmer avant écrasement',
    
    // Advanced
    enableCompression: 'Activer la compression',
    maxRetries: 'Nombre maximal de tentatives',
    debugMode: 'Mode débogage',
    
    // Tooltips
    resetConfirm: 'Êtes-vous sûr de vouloir réinitialiser tous les paramètres ?',
    resetSuccess: 'Paramètres réinitialisés avec succès !',
    saveSuccess: 'Paramètres sauvegardés avec succès !',
  },
  en: {
    settings: 'Settings',
    back: 'Back',
    save: 'Save',
    reset: 'Reset',
    appearance: 'Appearance',
    display: 'Display',
    notifications: 'Notifications',
    behavior: 'Behavior',
    advanced: 'Advanced',
    theme: 'Theme',
    themeSystem: 'System',
    themeLight: 'Light',
    themeDark: 'Dark',
    language: 'Language',
    accentColor: 'Accent Color',
    showFileIcons: 'Show file icons',
    showFileSize: 'Show file sizes',
    showFileDate: 'Show file dates',
    showProgressBar: 'Show progress bar',
    showConnectionStatus: 'Show connection status',
    itemsPerPage: 'Items per page',
    notificationsEnabled: 'Notifications enabled',
    notificationSound: 'Notification sound',
    notificationDuration: 'Notification duration (seconds)',
    autoRefresh: 'Auto refresh',
    autoRefreshInterval: 'Refresh interval (seconds)',
    confirmDelete: 'Confirm before delete',
    confirmOverwrite: 'Confirm before overwrite',
    enableCompression: 'Enable compression',
    maxRetries: 'Maximum retries',
    debugMode: 'Debug mode',
    resetConfirm: 'Are you sure you want to reset all settings?',
    resetSuccess: 'Settings reset successfully!',
    saveSuccess: 'Settings saved successfully!',
  },
  es: {
    settings: 'Configuración',
    back: 'Atrás',
    save: 'Guardar',
    reset: 'Restablecer',
    appearance: 'Apariencia',
    display: 'Visualización',
    notifications: 'Notificaciones',
    behavior: 'Comportamiento',
    advanced: 'Avanzado',
    theme: 'Tema',
    themeSystem: 'Sistema',
    themeLight: 'Claro',
    themeDark: 'Oscuro',
    language: 'Idioma',
    accentColor: 'Color de acento',
  },
  de: {
    settings: 'Einstellungen',
    back: 'Zurück',
    save: 'Speichern',
    theme: 'Thema',
    language: 'Sprache',
  },
  it: {
    settings: 'Impostazioni',
    back: 'Indietro',
    save: 'Salva',
    theme: 'Tema',
    language: 'Lingua',
  },
};

// ============================================================================
// Configuration Options
// ============================================================================

const THEMES = [
  { value: 'system' as const, label: { fr: 'Système', en: 'System', es: 'Sistema', de: 'System', it: 'Sistema' } },
  { value: 'light' as const, label: { fr: 'Clair', en: 'Light', es: 'Claro', de: 'Hell', it: 'Chiaro' } },
  { value: 'dark' as const, label: { fr: 'Sombre', en: 'Dark', es: 'Oscuro', de: 'Dunkel', it: 'Scuro' } },
];

const LANGUAGES = [
  { value: 'fr' as const, label: 'Français' },
  { value: 'en' as const, label: 'English' },
  { value: 'es' as const, label: 'Español' },
  { value: 'de' as const, label: 'Deutsch' },
  { value: 'it' as const, label: 'Italiano' },
];

const ACCENT_COLORS = [
  { value: '#a78bfa', label: 'Violet' },
  { value: '#ec4899', label: 'Rose' },
  { value: '#3b82f6', label: 'Bleu' },
  { value: '#10b981', label: 'Vert' },
  { value: '#f59e0b', label: 'Orange' },
  { value: '#ef4444', label: 'Rouge' },
];

const ITEMS_PER_PAGE = [
  { value: 10, label: '10' },
  { value: 25, label: '25' },
  { value: 50, label: '50' },
  { value: 100, label: '100' },
  { value: 200, label: '200' },
];

const NOTIFICATION_DURATIONS = [
  { value: 3, label: '3' },
  { value: 5, label: '5' },
  { value: 8, label: '8' },
  { value: 10, label: '10' },
];

const REFRESH_INTERVALS = [
  { value: 10, label: '10' },
  { value: 30, label: '30' },
  { value: 60, label: '60' },
  { value: 120, label: '120' },
];

const MAX_RETRIES = [
  { value: 1, label: '1' },
  { value: 3, label: '3' },
  { value: 5, label: '5' },
  { value: 10, label: '10' },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get translation for current language
 */
function getT(lang: string, key: string): string {
  const langData = TRANSLATIONS[lang as keyof typeof TRANSLATIONS];
  if (langData && langData[key]) {
    return langData[key];
  }
  // Fallback to French
  return TRANSLATIONS.fr[key] || key;
}

/**
 * Get label for theme option based on language
 */
function getThemeLabel(theme: typeof THEMES[0], lang: string): string {
  return theme.label[lang as keyof typeof theme.label] || theme.label.fr || theme.value;
}

// ============================================================================
// Component
// ============================================================================

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [language, setLanguage] = useState<string>('fr');
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showSaveSuccess, setShowSaveSuccess] = useState(false);

  // Load settings on mount
  useEffect(() => {
    const loadedSettings = loadSettings();
    setSettings(loadedSettings);
    setLanguage(loadedSettings.language || 'fr');
  }, []);

  // Apply theme and language when settings change
  useEffect(() => {
    applyTheme(settings.theme);
    applyAccentColor(settings.accentColor);
    applyLanguage(settings.language);
  }, [settings.theme, settings.accentColor, settings.language]);

  // Get translations based on current language
  const t = (key: string) => getT(language, key);

  // Handle setting change
  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    if (key === 'language') {
      setLanguage(value as string);
    }
  };

  // Handle save
  const handleSave = () => {
    saveSettings(settings);
    setShowSaveSuccess(true);
    setTimeout(() => setShowSaveSuccess(false), 3000);
  };

  // Handle reset
  const handleReset = () => {
    if (!showResetConfirm) {
      setShowResetConfirm(true);
      return;
    }
    const reset = resetSettings();
    setSettings({ ...reset });
    setLanguage(reset.language || 'fr');
    setShowResetConfirm(false);
    setShowSaveSuccess(true);
    setTimeout(() => setShowSaveSuccess(false), 3000);
  };

  // Cancel reset
  const handleCancelReset = () => {
    setShowResetConfirm(false);
  };

  // Go back
  const handleBack = () => {
    router.back();
  };

  return (
    <main className="gs-settings-page" role="main" aria-label={t('settings')}>
      {/* Header */}
      <header className="gs-settings-header">
        <button 
          onClick={handleBack}
          className="gs-back-button"
          aria-label={t('back')}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          <span>{t('back')}</span>
        </button>
        <h1 className="gs-settings-title">{t('settings')}</h1>
        <div className="gs-settings-actions">
          <button 
            onClick={showResetConfirm ? handleReset : () => setShowResetConfirm(true)}
            className="gs-button gs-button--secondary"
            disabled={showSaveSuccess}
          >
            {t('reset')}
          </button>
          <button 
            onClick={handleSave}
            className="gs-button gs-button--primary"
            disabled={showSaveSuccess}
          >
            {t('save')}
          </button>
        </div>
      </header>

      {/* Success Message */}
      {showSaveSuccess && (
        <div className="gs-alert gs-alert--success">
          {t('saveSuccess')}
        </div>
      )}

      {/* Reset Confirmation */}
      {showResetConfirm && (
        <div className="gs-alert gs-alert--warning">
          {t('resetConfirm')}
          <div className="gs-alert-actions">
            <button onClick={handleCancelReset} className="gs-button gs-button--text">
              Annuler
            </button>
            <button onClick={handleReset} className="gs-button gs-button--danger">
              Confirmer
            </button>
          </div>
        </div>
      )}

      {/* Settings Content */}
      <div className="gs-settings-content">
        
        {/* ======================================================================== */}
        {/* Appearance Settings */}
        {/* ======================================================================== */}
        <section className="gs-settings-section" aria-labelledby="appearance-heading">
          <h2 id="appearance-heading" className="gs-settings-section-title">
            {t('appearance')}
          </h2>
          <div className="gs-settings-grid">
            
            {/* Theme */}
            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label htmlFor="theme">{t('theme')}</label>
              </div>
              <div className="gs-setting-control">
                <select
                  id="theme"
                  value={settings.theme}
                  onChange={(e) => handleChange('theme', e.target.value as AppSettings['theme'])}
                  className="gs-select"
                >
                  {THEMES.map((theme) => (
                    <option key={theme.value} value={theme.value}>
                      {getThemeLabel(theme, language)}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Language */}
            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label htmlFor="language">{t('language')}</label>
              </div>
              <div className="gs-setting-control">
                <select
                  id="language"
                  value={settings.language}
                  onChange={(e) => handleChange('language', e.target.value as AppSettings['language'])}
                  className="gs-select"
                >
                  {LANGUAGES.map((lang) => (
                    <option key={lang.value} value={lang.value}>
                      {lang.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Accent Color */}
            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label htmlFor="accentColor">{t('accentColor')}</label>
              </div>
              <div className="gs-setting-control gs-color-picker">
                <select
                  id="accentColor"
                  value={settings.accentColor}
                  onChange={(e) => handleChange('accentColor', e.target.value)}
                  className="gs-select"
                >
                  {ACCENT_COLORS.map((color) => (
                    <option key={color.value} value={color.value}>
                      {color.label}
                    </option>
                  ))}
                </select>
                <div 
                  className="gs-color-preview"
                  style={{ backgroundColor: settings.accentColor }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ======================================================================== */}
        {/* Display Settings */}
        {/* ======================================================================== */}
        <section className="gs-settings-section" aria-labelledby="display-heading">
          <h2 id="display-heading" className="gs-settings-section-title">
            {t('display')}
          </h2>
          <div className="gs-settings-grid">
            
            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('showFileIcons')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.showFileIcons}
                    onChange={(e) => handleChange('showFileIcons', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('showFileSize')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.showFileSize}
                    onChange={(e) => handleChange('showFileSize', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('showFileDate')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.showFileDate}
                    onChange={(e) => handleChange('showFileDate', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('showProgressBar')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.showProgressBar}
                    onChange={(e) => handleChange('showProgressBar', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('showConnectionStatus')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.showConnectionStatus}
                    onChange={(e) => handleChange('showConnectionStatus', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label htmlFor="itemsPerPage">{t('itemsPerPage')}</label>
              </div>
              <div className="gs-setting-control">
                <select
                  id="itemsPerPage"
                  value={settings.itemsPerPage}
                  onChange={(e) => handleChange('itemsPerPage', Number(e.target.value))}
                  className="gs-select"
                >
                  {ITEMS_PER_PAGE.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* ======================================================================== */}
        {/* Notifications Settings */}
        {/* ======================================================================== */}
        <section className="gs-settings-section" aria-labelledby="notifications-heading">
          <h2 id="notifications-heading" className="gs-settings-section-title">
            {t('notifications')}
          </h2>
          <div className="gs-settings-grid">
            
            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('notificationsEnabled')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.notificationsEnabled}
                    onChange={(e) => handleChange('notificationsEnabled', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('notificationSound')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.notificationSound}
                    onChange={(e) => handleChange('notificationSound', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label htmlFor="notificationDuration">{t('notificationDuration')}</label>
              </div>
              <div className="gs-setting-control">
                <select
                  id="notificationDuration"
                  value={settings.notificationDuration}
                  onChange={(e) => handleChange('notificationDuration', Number(e.target.value))}
                  className="gs-select"
                >
                  {NOTIFICATION_DURATIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </section>

        {/* ======================================================================== */}
        {/* Behavior Settings */}
        {/* ======================================================================== */}
        <section className="gs-settings-section" aria-labelledby="behavior-heading">
          <h2 id="behavior-heading" className="gs-settings-section-title">
            {t('behavior')}
          </h2>
          <div className="gs-settings-grid">
            
            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('autoRefresh')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.autoRefresh}
                    onChange={(e) => handleChange('autoRefresh', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label htmlFor="autoRefreshInterval">{t('autoRefreshInterval')}</label>
              </div>
              <div className="gs-setting-control">
                <select
                  id="autoRefreshInterval"
                  value={settings.autoRefreshInterval}
                  onChange={(e) => handleChange('autoRefreshInterval', Number(e.target.value))}
                  className="gs-select"
                >
                  {REFRESH_INTERVALS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('confirmDelete')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.confirmDelete}
                    onChange={(e) => handleChange('confirmDelete', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('confirmOverwrite')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.confirmOverwrite}
                    onChange={(e) => handleChange('confirmOverwrite', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>
          </div>
        </section>

        {/* ======================================================================== */}
        {/* Advanced Settings */}
        {/* ======================================================================== */}
        <section className="gs-settings-section" aria-labelledby="advanced-heading">
          <h2 id="advanced-heading" className="gs-settings-section-title">
            {t('advanced')}
          </h2>
          <div className="gs-settings-grid">
            
            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('enableCompression')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.enableCompression}
                    onChange={(e) => handleChange('enableCompression', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label htmlFor="maxRetries">{t('maxRetries')}</label>
              </div>
              <div className="gs-setting-control">
                <select
                  id="maxRetries"
                  value={settings.maxRetries}
                  onChange={(e) => handleChange('maxRetries', Number(e.target.value))}
                  className="gs-select"
                >
                  {MAX_RETRIES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="gs-setting-item">
              <div className="gs-setting-label">
                <label>{t('debugMode')}</label>
              </div>
              <div className="gs-setting-control">
                <label className="gs-toggle">
                  <input
                    type="checkbox"
                    checked={settings.debugMode}
                    onChange={(e) => handleChange('debugMode', e.target.checked)}
                  />
                  <span className="gs-toggle-slider" />
                </label>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* Footer */}
      <footer className="gs-settings-footer">
        <button 
          onClick={handleBack}
          className="gs-button gs-button--secondary"
        >
          {t('back')}
        </button>
        <span className="gs-settings-version">v1.0.14</span>
      </footer>
    </main>
  );
}
