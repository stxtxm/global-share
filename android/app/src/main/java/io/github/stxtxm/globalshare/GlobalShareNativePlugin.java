package io.github.stxtxm.globalshare;

import android.Manifest;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

/** Pont natif exposé à la page sous le nom « GlobalShareNative ». */
@CapacitorPlugin(
        name = "GlobalShareNative",
        permissions = {
            @Permission(
                    alias = "notifications",
                    strings = {Manifest.permission.POST_NOTIFICATIONS}),
            @Permission(
                    alias = "install",
                    strings = {Manifest.permission.REQUEST_INSTALL_PACKAGES})
        })
public class GlobalShareNativePlugin extends Plugin {
    private static final long FIRST_CHECK_DELAY_MS = 8_000;
    private static final long CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable periodicCheck = new Runnable() {
        @Override
        public void run() {
            // Comme sur desktop : une vérification de fond silencieuse. Une
            // mise à jour disponible publie l'état « available », ce qui rend
            // l'encart visible sans que l'utilisateur ait à chercher.
            UpdateManager.checkForUpdates(false);
            mainHandler.postDelayed(this, CHECK_INTERVAL_MS);
        }
    };
    private boolean scheduled;

    @Override
    public void load() {
        super.load();
        UpdateManager.init(getContext());
        UpdaterState.setListener(new UpdaterState.Listener() {
            @Override
            public void onState(JSObject state) {
                // Pas de rétention : l'UI demande toujours l'état courant au
                // montage via getUpdateState(), y compris après un rechargement.
                onUiThread(() -> notifyListeners("updateState", state));
            }

            @Override
            public void onOpen() {
                onUiThread(() -> notifyListeners("updateOpen", new JSObject()));
            }
        });

        if (!scheduled) {
            scheduled = true;
            mainHandler.postDelayed(periodicCheck, FIRST_CHECK_DELAY_MS);
        }
    }

    private void onUiThread(Runnable action) {
        if (getActivity() != null) getActivity().runOnUiThread(action);
        else action.run();
    }

    // ---- Mises à jour -----------------------------------------------------

    @PluginMethod
    public void getUpdateState(PluginCall call) {
        call.resolve(UpdateManager.snapshot());
    }

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        UpdateManager.checkForUpdates(true);
        call.resolve(UpdateManager.snapshot());
    }

    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        UpdateManager.downloadUpdate();
        call.resolve(UpdateManager.snapshot());
    }

    @PluginMethod
    public void installUpdate(PluginCall call) {
        // Bundle web : rebasage du WebView sur le dossier extrait, sans
        // réinstallation. setServerBasePath recharge la page par lui-même.
        UpdateManager.installUpdate(getActivity(), (webDir) -> {
            Bridge bridge = getBridge();
            if (bridge != null) bridge.setServerBasePath(webDir);
        });
        call.resolve(UpdateManager.snapshot());
    }

    @PluginMethod
    public void dismissUpdate(PluginCall call) {
        UpdateManager.dismiss();
        call.resolve(UpdateManager.snapshot());
    }

    // ---- Continuité des transferts ---------------------------------------

    @PluginMethod
    public void startTransfer(PluginCall call) {
        int count = call.getInt("count", 1);
        int progress = call.getInt("progress", 0);
        TransferForegroundService.start(getContext(), count, progress);
        call.resolve();
    }

    @PluginMethod
    public void updateTransferProgress(PluginCall call) {
        int count = call.getInt("count", 0);
        int progress = call.getInt("progress", 0);
        TransferForegroundService.update(getContext(), count, progress);
        call.resolve();
    }

    @PluginMethod
    public void stopTransfer(PluginCall call) {
        TransferForegroundService.stop(getContext());
        call.resolve();
    }

    /**
     * Session salon ouverte : maintient le service avant-plan (wake locks +
     * notification) même sans transfert, pour que la socket survive à
     * l'arrière-plan et à la veille. Appelé avec false quand l'app quitte le
     * salon ou se déconnecte.
     */
    @PluginMethod
    public void keepAlive(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", Boolean.FALSE));
        TransferForegroundService.setKeepAlive(getContext(), enabled);
        call.resolve();
    }

    /**
     * Demande (une seule fois par installation) l'exemption d'optimisation de
     * batterie : sans elle, Doze peut suspendre le réseau malgré le service
     * avant-plan sur certains constructeurs agressifs.
     */
    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        android.content.Context context = getContext();
        PowerManager power = (PowerManager) context.getSystemService(android.content.Context.POWER_SERVICE);
        String packageName = context.getPackageName();
        SharedPreferences prefs = context.getSharedPreferences("gsbg", android.content.Context.MODE_PRIVATE);
        boolean alreadyIgnored = power != null
                && (Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                    || power.isIgnoringBatteryOptimizations(packageName));
        if (alreadyIgnored || prefs.getBoolean("batteryAsked", false)) {
            call.resolve();
            return;
        }
        prefs.edit().putBoolean("batteryAsked", true).apply();
        android.app.Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + packageName));
            activity.startActivity(intent);
        } catch (Exception ignored) {
            // Écran sans ce réglage : on n'insiste pas.
        }
        call.resolve();
    }
}
