package io.github.stxtxm.globalshare;

import android.Manifest;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.os.Environment;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

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
        // Le service émet un tick toutes les 10 s : on le relaie vers le JS,
        // dont les timers sont bridés quand l'écran est éteint (veille).
        TransferForegroundService.setTickListener(() ->
                onUiThread(() -> notifyListeners("serviceTick", new JSObject())));
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
        if (enabled) {
            // Android 13+ : la notification du service doit être autorisée
            // AVANT le premier startForeground, sinon le démarrage échoue.
            try {
                android.content.Context context = getContext();
                if (Build.VERSION.SDK_INT >= 33
                        && ContextCompat.checkSelfPermission(context,
                                Manifest.permission.POST_NOTIFICATIONS)
                        != PackageManager.PERMISSION_GRANTED
                        && getActivity() != null) {
                    ActivityCompat.requestPermissions(getActivity(),
                            new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1001);
                }
            } catch (Exception ignored) {
                // Permissions refusées : le service démarre quand même avec la
                // notification de gestion des tâches affichée par Android.
            }
        }
        TransferForegroundService.setKeepAlive(getContext(), enabled);
        call.resolve();
    }

    // ---- Fichiers reçus : stockage partagé + ouverture système -----------

    /**
     * Écrit un morceau (base64) du fichier reçu dans Téléchargements/GlobalShare.
     * Le JS découpe en morceaux de 256 Ko : le pont Capacitor ne doit jamais
     * transporter une chaîne de dizaines de Mo d'un coup. La première fois,
     * on crée l'entrée MediaStore (ou le fichier sur Android < 10) et on
     * renvoie son URI ; les appels suivants ajoutent au même URI.
     */
    @PluginMethod
    public void saveDownload(PluginCall call) {
        String name = call.getString("name");
        String mime = call.getString("mime");
        String base64 = call.getString("bytes");
        String uriText = call.getString("uri");
        boolean append = Boolean.TRUE.equals(call.getBoolean("append", false));
        JSObject result = new JSObject();
        if (name == null || base64 == null) {
            result.put("error", "Nom ou contenu de fichier manquant.");
            call.resolve(result);
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            android.content.Context context = getContext();
            Uri uri;
            if (append && uriText != null) {
                uri = Uri.parse(uriText);
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                values.put(MediaStore.MediaColumns.MIME_TYPE,
                        mime != null ? mime : "application/octet-stream");
                values.put(MediaStore.Downloads.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/GlobalShare");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                uri = context.getContentResolver().insert(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    result.put("error", "Impossible de créer le fichier dans Téléchargements.");
                    call.resolve(result);
                    return;
                }
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS), "GlobalShare");
                if (!dir.exists() && !dir.mkdirs()) {
                    result.put("error", "Impossible de créer le dossier GlobalShare.");
                    call.resolve(result);
                    return;
                }
                File file = new File(dir, name);
                try (FileOutputStream out = new FileOutputStream(file, false)) {
                    out.write(bytes);
                }
                MediaScannerConnection.scanFile(context,
                        new String[]{file.getAbsolutePath()}, new String[]{mime}, null);
                uri = FileProvider.getUriForFile(context,
                        context.getPackageName() + ".fileprovider", file);
                result.put("uri", uri.toString());
                call.resolve(result);
                return;
            }
            try (OutputStream out = context.getContentResolver()
                    .openOutputStream(uri, (append && uriText != null) ? "wa" : "w")) {
                if (out == null) {
                    result.put("error", "Impossible d'écrire le fichier.");
                    call.resolve(result);
                    return;
                }
                out.write(bytes);
            }
            result.put("uri", uri.toString());
            call.resolve(result);
        } catch (Exception error) {
            result.put("error", "Enregistrement impossible : " + error.getMessage());
            call.resolve(result);
        }
    }

    /** Rend le fichier visible dès la fin de l'écriture (MediaStore IS_PENDING). */
    @PluginMethod
    public void finishDownload(PluginCall call) {
        String uriText = call.getString("uri");
        JSObject result = new JSObject();
        if (uriText == null) {
            call.resolve(result);
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    && uriText.startsWith("content://")) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                int updated = getContext().getContentResolver()
                        .update(Uri.parse(uriText), values, null, null);
                if (updated == 0) {
                    result.put("error", "Le fichier n'est plus présent dans Téléchargements.");
                }
            }
        } catch (Exception error) {
            result.put("error", "Fichier écrit mais pas encore indexé : " + error.getMessage());
        }
        call.resolve(result);
    }

    /** Ouvre le fichier avec le lecteur système (FLAC, audio, image, PDF…). */
    @PluginMethod
    public void openDownload(PluginCall call) {
        // Capacitor 8 n'accepte que resolve(JSObject) : l'erreur est renvoyée
        // dans un champ, pas comme chaîne (le builder Java rejette String).
        JSObject result = new JSObject();
        String uriText = call.getString("uri");
        String mime = call.getString("mime");
        if (uriText == null) {
            result.put("error", "Aucun fichier à ouvrir.");
            call.resolve(result);
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(Uri.parse(uriText),
                    mime != null ? mime : "application/octet-stream");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            // Chooser obligatoire : un ACTION_VIEW direct peut sélectionner un
            // lecteur vidéo qui déclare */* et plante sur un FLAC (l'app
            // semblait alors figée au retour). L'utilisateur choisit son lecteur.
            Intent chooser = Intent.createChooser(intent, "Écouter avec");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
        } catch (Exception error) {
            result.put("error", "Ouverture impossible : " + error.getMessage());
        }
        call.resolve(result);
    }

    /**
     * Ouvre le gestionnaire de fichiers dans Téléchargements/GlobalShare.
     * Sur Pixel 9a, un lancement direct par nom de paquet échoue avec une
     * SecurityException liée à l'UID (10415). Le chemin qui fonctionne est le
     * même que « Écouter » : ACTION_VIEW + createChooser depuis le contexte
     * applicatif. Le choisir affiche notamment Google Files, qui ouvre le
     * dossier grâce à EXTRA_INITIAL_URI.
     */
    @PluginMethod
    public void revealDownload(PluginCall call) {
        JSObject result = new JSObject();
        try {
            Uri folder = DocumentsContract.buildDocumentUri(
                    "com.android.externalstorage.documents", "primary:Download/GlobalShare");
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setData(folder);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                view.putExtra(DocumentsContract.EXTRA_INITIAL_URI, folder);
            }
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(view, "Ouvrir le dossier avec");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
        } catch (Exception error) {
            result.put("error", "Ouverture du gestionnaire impossible : " + error.getMessage());
        }
        call.resolve(result);
    }

    /**
     * Liste les fichiers RÉELLEMENT présents dans Téléchargements/GlobalShare.
     * Source de vérité indépendante de l'historique IndexedDB : permet de voir,
     * ouvrir et supprimer un fichier même si l'entrée de l'historique a été
     * perdue ou si l'enregistrement a échoué silencieusement.
     */
    @PluginMethod
    public void listDownloads(PluginCall call) {
        JSObject result = new JSObject();
        com.getcapacitor.JSArray files = new com.getcapacitor.JSArray();
        try {
            android.content.Context context = getContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                String[] projection = {
                        MediaStore.MediaColumns._ID,
                        MediaStore.MediaColumns.DISPLAY_NAME,
                        MediaStore.MediaColumns.SIZE
                };
                String selection = MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?";
                String[] args = {"%" + Environment.DIRECTORY_DOWNLOADS + "/GlobalShare%"};
                Cursor cursor = context.getContentResolver().query(
                        MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                        projection, selection, args,
                        MediaStore.MediaColumns.DATE_ADDED + " DESC");
                if (cursor != null) {
                    try {
                        while (cursor.moveToNext()) {
                            JSObject file = new JSObject();
                            long id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID));
                            String name = cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME));
                            long size = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE));
                            file.put("uri", android.content.ContentUris.withAppendedId(
                                    MediaStore.Downloads.EXTERNAL_CONTENT_URI, id).toString());
                            file.put("name", name == null ? "fichier" : name);
                            file.put("size", size);
                            files.put(file);
                        }
                    } finally {
                        cursor.close();
                    }
                }
            } else {
                File dir = new File(Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS), "GlobalShare");
                File[] entries = dir.listFiles();
                if (entries != null) {
                    for (File file : entries) {
                        if (!file.isFile()) continue;
                        JSObject item = new JSObject();
                        item.put("uri", FileProvider.getUriForFile(context,
                                context.getPackageName() + ".fileprovider", file).toString());
                        item.put("name", file.getName());
                        item.put("size", file.length());
                        files.put(item);
                    }
                }
            }
        } catch (Exception error) {
            result.put("error", "Lecture du dossier impossible : " + error.getMessage());
        }
        result.put("files", files);
        call.resolve(result);
    }

    /** État du service pour le diagnostic (Notification, réglages). */
    @PluginMethod
    public void getServiceState(PluginCall call) {
        JSObject state = new JSObject();
        state.put("running", TransferForegroundService.isRunning());
        state.put("batteryOptimized", TransferForegroundService.isBatteryOptimized(getContext()));
        call.resolve(state);
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
        if (alreadyIgnored) {
            call.resolve();
            return;
        }
        // Ne jamais persister « déjà demandé » AVANT l'affichage : un refus ou
        // une activité indisponible laissait le flag à true pour toujours et
        // Doze coupait le réseau en veille sans qu'on puisse redemander.
        android.app.Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + packageName));
            activity.startActivity(intent);
            prefs.edit().putBoolean("batteryAsked", true).apply();
        } catch (Exception ignored) {
            // Écran sans ce réglage : on n'insiste pas.
        }
        call.resolve();
    }
}
