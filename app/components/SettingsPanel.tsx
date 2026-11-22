'use client';

import type { CSSProperties } from 'react';
import type { AppSettings } from '../lib/settings';
import { ACCENT_SWATCHES, translate as translateSetting } from '../lib/settings-i18n';
import pkgVersion from '../../package.json';

// ----------------------------------------------------------------------------
// Réglages : constantes et petits composants internes
// ----------------------------------------------------------------------------

interface SettingToggleProps {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}

/** Interrupteur stylé, cible tactile 48 px, sans dépendance externe. */
function SettingToggle({ label, hint, checked, disabled = false, onChange }: SettingToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={`gs-setting gs-setting--toggle${checked ? ' is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <div>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <span className="gs-switch" aria-hidden="true">
        <span className="gs-switch-knob" />
      </span>
    </button>
  );
}

interface SettingsPanelProps {
  appSettings: AppSettings;
  updateAppSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
  resetAllSettings: () => void;
  /** Version affichée en pied de panneau (accueil) sinon (overlay salon). */
  showVersion?: boolean;
}

/**
 * Corps du panneau de réglages, partagé par la vue accueil (« settings »)
 * et la page plein écran par-dessus le salon : une seule source pour tout
 * le contenu, quel que soit le contexte d'affichage. Tous les libellés sont
 * traduits dans la langue choisie (repli sur le français).
 */
function SettingsPanel({
  appSettings,
  updateAppSetting,
  resetAllSettings,
  showVersion = true,
}: SettingsPanelProps) {
  const t = (key: string) => translateSetting(appSettings.language, key);

  return (
    <>
      {/* ---- Apparence ---- */}
      <h2 className="gs-list-title">{t('appearance')}</h2>
      <div className="gs-card gs-card--pad">
        <div className="gs-setting">
          <div>
            <strong>{t('theme')}</strong>
            <small>{t('themeHint')}</small>
          </div>
          <div className="gs-seg" role="group" aria-label={t('theme')}>
            {(
              [
                { value: 'system', key: 'themeSystem' },
                { value: 'light', key: 'themeLight' },
                { value: 'dark', key: 'themeDark' },
              ] as const
            ).map(option => (
              <button
                key={option.value}
                type="button"
                className={`gs-seg-btn${appSettings.theme === option.value ? ' is-active' : ''}`}
                aria-pressed={appSettings.theme === option.value}
                onClick={() => updateAppSetting('theme', option.value)}
              >
                {t(option.key)}
              </button>
            ))}
          </div>
        </div>

        <div className="gs-setting">
          <div>
            <strong>{t('language')}</strong>
            <small>{t('languageHint')}</small>
          </div>
          <select
            className="gs-setting-select"
            value={appSettings.language}
            onChange={e => updateAppSetting('language', e.target.value as AppSettings['language'])}
            aria-label={t('language')}
          >
            <option value="fr">Français</option>
            <option value="en">English</option>
            <option value="es">Español</option>
            <option value="de">Deutsch</option>
            <option value="it">Italiano</option>
          </select>
        </div>

        <div className="gs-setting">
          <div>
            <strong>{t('accentColor')}</strong>
            <small>{t('accentHint')}</small>
          </div>
          <div className="gs-swatches" role="group" aria-label={t('accentColor')}>
            {ACCENT_SWATCHES.map(color => {
              const label = t(color.labelKey);
              return (
                <button
                  key={color.value}
                  type="button"
                  className={`gs-swatch${appSettings.accentColor === color.value ? ' is-active' : ''}`}
                  style={{ '--swatch': color.value } as CSSProperties}
                  aria-label={label}
                  title={label}
                  aria-pressed={appSettings.accentColor === color.value}
                  onClick={() => updateAppSetting('accentColor', color.value)}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* ---- Affichage ---- */}
      <h2 className="gs-list-title">{t('display')}</h2>
      <div className="gs-card gs-card--pad">
        <SettingToggle
          label={t('showFileIcons')}
          hint={t('showFileIconsHint')}
          checked={appSettings.showFileIcons}
          onChange={value => updateAppSetting('showFileIcons', value)}
        />
        <SettingToggle
          label={t('showFileSize')}
          hint={t('showFileSizeHint')}
          checked={appSettings.showFileSize}
          onChange={value => updateAppSetting('showFileSize', value)}
        />
        <SettingToggle
          label={t('showFileDate')}
          hint={t('showFileDateHint')}
          checked={appSettings.showFileDate}
          onChange={value => updateAppSetting('showFileDate', value)}
        />
        <SettingToggle
          label={t('showProgressBar')}
          hint={t('showProgressBarHint')}
          checked={appSettings.showProgressBar}
          onChange={value => updateAppSetting('showProgressBar', value)}
        />
        <SettingToggle
          label={t('showConnectionStatus')}
          hint={t('showConnectionStatusHint')}
          checked={appSettings.showConnectionStatus}
          onChange={value => updateAppSetting('showConnectionStatus', value)}
        />
        <div className="gs-setting">
          <div>
            <strong>{t('itemsPerPage')}</strong>
            <small>{t('itemsPerPageHint')}</small>
          </div>
          <select
            className="gs-setting-select"
            value={appSettings.itemsPerPage}
            onChange={e => updateAppSetting('itemsPerPage', Number(e.target.value))}
            aria-label={t('itemsPerPage')}
          >
            {[10, 25, 50, 100, 200].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- Notifications ---- */}
      <h2 className="gs-list-title">{t('notifications')}</h2>
      <div className="gs-card gs-card--pad">
        <SettingToggle
          label={t('notificationsEnabled')}
          hint={t('notificationsEnabledHint')}
          checked={appSettings.notificationsEnabled}
          onChange={value => updateAppSetting('notificationsEnabled', value)}
        />
        <SettingToggle
          label={t('notificationSound')}
          hint={t('notificationSoundHint')}
          checked={appSettings.notificationSound}
          disabled={!appSettings.notificationsEnabled}
          onChange={value => updateAppSetting('notificationSound', value)}
        />
        <div className="gs-setting">
          <div>
            <strong>{t('notificationDuration')}</strong>
            <small>{t('notificationDurationHint')}</small>
          </div>
          <select
            className="gs-setting-select"
            value={appSettings.notificationDuration}
            disabled={!appSettings.notificationsEnabled}
            onChange={e => updateAppSetting('notificationDuration', Number(e.target.value))}
            aria-label={t('notificationDuration')}
          >
            {[3, 5, 8, 10].map(n => (
              <option key={n} value={n}>{n} s</option>
            ))}
          </select>
        </div>
      </div>

      {/* ---- Comportement ---- */}
      <h2 className="gs-list-title">{t('behavior')}</h2>
      <div className="gs-card gs-card--pad">
        <SettingToggle
          label={t('autoRefresh')}
          hint={t('autoRefreshHint')}
          checked={appSettings.autoRefresh}
          onChange={value => updateAppSetting('autoRefresh', value)}
        />
        <div className="gs-setting">
          <div>
            <strong>{t('autoRefreshInterval')}</strong>
            <small>{t('autoRefreshIntervalHint')}</small>
          </div>
          <select
            className="gs-setting-select"
            value={appSettings.autoRefreshInterval}
            disabled={!appSettings.autoRefresh}
            onChange={e => updateAppSetting('autoRefreshInterval', Number(e.target.value))}
            aria-label={t('autoRefreshInterval')}
          >
            {[10, 30, 60, 120].map(n => (
              <option key={n} value={n}>{n} s</option>
            ))}
          </select>
        </div>
        <SettingToggle
          label={t('confirmDelete')}
          hint={t('confirmDeleteHint')}
          checked={appSettings.confirmDelete}
          onChange={value => updateAppSetting('confirmDelete', value)}
        />
        <SettingToggle
          label={t('confirmOverwrite')}
          hint={t('confirmOverwriteHint')}
          checked={appSettings.confirmOverwrite}
          onChange={value => updateAppSetting('confirmOverwrite', value)}
        />
      </div>

      {/* ---- Avancé ---- */}
      <h2 className="gs-list-title">{t('advanced')}</h2>
      <div className="gs-card gs-card--pad">
        <SettingToggle
          label={t('enableCompression')}
          hint={t('enableCompressionHint')}
          checked={appSettings.enableCompression}
          onChange={value => updateAppSetting('enableCompression', value)}
        />
        <div className="gs-setting">
          <div>
            <strong>{t('maxRetries')}</strong>
            <small>{t('maxRetriesHint')}</small>
          </div>
          <select
            className="gs-setting-select"
            value={appSettings.maxRetries}
            onChange={e => updateAppSetting('maxRetries', Number(e.target.value))}
            aria-label={t('maxRetries')}
          >
            {[1, 3, 5, 10].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <SettingToggle
          label={t('debugMode')}
          hint={t('debugModeHint')}
          checked={appSettings.debugMode}
          onChange={value => updateAppSetting('debugMode', value)}
        />
      </div>

      <div className="gs-settings-footer">
        <button
          type="button"
          className="gs-btn gs-btn--ghost gs-btn--sm"
          onClick={resetAllSettings}
        >
          {t('resetSettings')}
        </button>
        {showVersion && <small>GlobalShare v{pkgVersion?.version ?? 'dev'}</small>}
      </div>
    </>
  );
}

export default SettingsPanel;
