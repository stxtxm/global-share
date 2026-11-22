package io.github.stxtxm.globalshare;

import android.Manifest;
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
}
