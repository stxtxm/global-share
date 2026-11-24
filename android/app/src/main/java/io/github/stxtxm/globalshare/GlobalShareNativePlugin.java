package io.github.stxtxm.globalshare;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Context;
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
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;

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
        // Le service peut survivre à l'interface (transfert en cours après
        // fermeture de l'app) : un tick envoyé à un bridge détruit ne doit pas
        // lever d'exception sur le thread principal.
        TransferForegroundService.setTickListener(() ->
                onUiThread(() -> {
                    try {
                        if (getBridge() == null || getActivity() == null) return;
                        notifyListeners("serviceTick", new JSObject());
                    } catch (Exception ignored) {
                        // WebView détruit entre le tick et l'envoi.
                    }
                }));
    }

    @Override
    public void handleOnDestroy() {
        // Interface détruite : plus personne pour recevoir le tick du service.
        TransferForegroundService.setTickListener(null);
        super.handleOnDestroy();
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

    // ---- Dossier de réception choisi par l'utilisateur --------------------

    private static final String FOLDER_PREFS = "globalshare_receive_folder";
    private static final String PREF_FOLDER_URI = "treeUri";
    private static final String PREF_FOLDER_LABEL = "label";
    private static final String PREF_FOLDER_KNOWN = "knownTrees";
    private static final String DEFAULT_FOLDER_LABEL = "Téléchargements/GlobalShare";

    private SharedPreferences folderPrefs() {
        return getContext().getSharedPreferences(FOLDER_PREFS, Context.MODE_PRIVATE);
    }

    /** Arborescence SAF choisie dans les réglages, ou null (dossier par défaut). */
    private Uri chosenFolderTree() {
        String value = folderPrefs().getString(PREF_FOLDER_URI, null);
        if (value == null || value.isEmpty()) return null;
        return Uri.parse(value);
    }

    /**
     * Toutes les arborescences déjà choisies (courante comprise). Les fichiers
     * reçus avant un changement de dossier restent ainsi listés et ouvrables,
     * comme sur desktop où l'historique des dossiers est conservé.
     */
    private Set<String> knownFolderTrees() {
        Set<String> known = new HashSet<>(
                folderPrefs().getStringSet(PREF_FOLDER_KNOWN, Collections.emptySet()));
        Uri current = chosenFolderTree();
        if (current != null) known.add(current.toString());
        return known;
    }

    /** Dossier de réception courant : libellé lisible + indicateur « choisi ». */
    @PluginMethod
    public void getReceiveFolder(PluginCall call) {
        JSObject result = new JSObject();
        Uri tree = chosenFolderTree();
        result.put("path", tree == null
                ? DEFAULT_FOLDER_LABEL
                : folderPrefs().getString(PREF_FOLDER_LABEL, "Dossier choisi"));
        result.put("custom", tree != null);
        call.resolve(result);
    }

    /** Ouvre le sélecteur de dossier SAF ; le choix est persisté pour de bon. */
    @PluginMethod
    public void chooseReceiveFolder(PluginCall call) {
        JSObject result = new JSObject();
        try {
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                    | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
            startActivityForResult(call, intent, "receiveFolderPicked");
        } catch (Exception error) {
            result.put("error", "Sélecteur de dossier indisponible : " + error.getMessage());
            call.resolve(result);
        }
    }

    @ActivityCallback
    private void receiveFolderPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        JSObject output = new JSObject();
        Intent data = result.getData();
        Uri tree = data == null ? null : data.getData();
        if (result.getResultCode() != Activity.RESULT_OK || tree == null) {
            output.put("canceled", true);
            call.resolve(output);
            return;
        }
        // Le dossier par défaut de l'app choisi via SAF n'est pas un dossier
        // « personnalisé » : le traiter comme tel le ferait apparaître deux
        // fois (MediaStore + arborescence SAF) dans la liste des fichiers.
        String treeId = "";
        try {
            treeId = DocumentsContract.getTreeDocumentId(tree);
        } catch (Exception ignored) {
            // Identifiant illisible : on garde le choix tel quel.
        }
        if ("primary:Download/GlobalShare".equals(treeId)) {
            folderPrefs().edit().remove(PREF_FOLDER_URI).remove(PREF_FOLDER_LABEL).apply();
            output.put("path", DEFAULT_FOLDER_LABEL);
            output.put("custom", false);
            call.resolve(output);
            return;
        }
        try {
            int flags = data.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION
                    | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            if (flags == 0) {
                flags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
            }
            getContext().getContentResolver().takePersistableUriPermission(tree, flags);
        } catch (Exception ignored) {
            // Certains fournisseurs ne persistent pas : le dossier reste
            // utilisable tant que l'autorisation est accordée à la session.
        }
        String label = labelForTree(tree);
        Set<String> known = new HashSet<>(
                folderPrefs().getStringSet(PREF_FOLDER_KNOWN, Collections.emptySet()));
        known.add(tree.toString());
        folderPrefs().edit()
                .putString(PREF_FOLDER_URI, tree.toString())
                .putString(PREF_FOLDER_LABEL, label)
                .putStringSet(PREF_FOLDER_KNOWN, known)
                .apply();
        output.put("path", label);
        output.put("custom", true);
        call.resolve(output);
    }

    /** Nom du dossier choisi (l'URI SAF complète n'est pas montrable telle quelle). */
    private String labelForTree(Uri tree) {
        try {
            Uri document = DocumentsContract.buildDocumentUriUsingTree(
                    tree, DocumentsContract.getTreeDocumentId(tree));
            try (Cursor cursor = getContext().getContentResolver().query(
                    document,
                    new String[]{DocumentsContract.Document.COLUMN_DISPLAY_NAME},
                    null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    String name = cursor.getString(0);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // Repli : libellé générique plutôt qu'une URI brute dans l'UI.
        }
        return "Dossier choisi";
    }

    @PluginMethod
    public void resetReceiveFolder(PluginCall call) {
        JSObject result = new JSObject();
        folderPrefs().edit().remove(PREF_FOLDER_URI).remove(PREF_FOLDER_LABEL).apply();
        result.put("path", DEFAULT_FOLDER_LABEL);
        result.put("custom", false);
        call.resolve(result);
    }

    /** Crée le fichier dans l'arborescence choisie, ou null pour un repli. */
    private Uri createInChosenFolder(String name, String mime) {
        Uri tree = chosenFolderTree();
        if (tree == null) return null;
        try {
            Uri parent = DocumentsContract.buildDocumentUriUsingTree(
                    tree, DocumentsContract.getTreeDocumentId(tree));
            return DocumentsContract.createDocument(
                    getContext().getContentResolver(), parent,
                    mime != null ? mime : "application/octet-stream", name);
        } catch (Exception error) {
            return null;
        }
    }

    // ---- Fichiers reçus : stockage partagé + ouverture système -----------

    /**
     * Écrit un morceau (base64) du fichier reçu dans le dossier de réception
     * (Téléchargements/GlobalShare par défaut, ou l'arborescence SAF choisie).
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
            } else if (chosenFolderTree() != null
                    && (uri = createInChosenFolder(name, mime)) != null) {
                // Dossier choisi dans les réglages : le fichier va dans
                // l'arborescence SAF, la suite commune écrit les morceaux.
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
            // Seul MediaStore utilise IS_PENDING : une URI SAF de dossier
            // choisi n'a pas cette colonne et l'update échouerait.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    && "media".equals(Uri.parse(uriText).getAuthority())) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                int updated = getContext().getContentResolver()
                        .update(Uri.parse(uriText), values, null, null);
                if (updated == 0) {
                    result.put("error", "Le fichier n'est plus présent dans le dossier de réception.");
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
     * Ouvre le gestionnaire de fichiers du système dans le dossier de réception.
     * Ordre d'essai : (1) ACTION_OPEN_DOCUMENT_TREE via DocumentsUI (nécessite
     * un agent de permission DocumentsUI, ci-dessous Android 11 via
     * DocumentsContract.EXTRA_INITIAL_URI), (2) lancement direct de Google Files
     * ou DocumentsUI par nom de paquet, (3) ACTION_OPEN_DOCUMENT fallback (n'a
     * pas besoin d'URI grant fourni par nous).
     */
    @PluginMethod
    public void revealDownload(PluginCall call) {
        JSObject result = new JSObject();
        try {
            // Dossier choisi : le sélecteur s'ouvre directement dedans, sinon
            // sur le dossier par défaut de l'application.
            Uri chosen = chosenFolderTree();
            Uri folder = chosen != null
                    ? DocumentsContract.buildDocumentUriUsingTree(
                            chosen, DocumentsContract.getTreeDocumentId(chosen))
                    : DocumentsContract.buildDocumentUri(
                            "com.android.externalstorage.documents", "primary:Download/GlobalShare");

            // 1) ACTION_OPEN_DOCUMENT_TREE : DocumentsUI gère lui-même
            // l'identification, c'est pourquoi notre SecurityException UID
            // n'a plus lieu.
            Intent tree = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                // EXTRA_INITIAL_URI depuis Android 11 : initial URI du dossier
                // ouvert dès le démarrage du sélecteur.
                tree.putExtra(DocumentsContract.EXTRA_INITIAL_URI, folder);
            }
            tree.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (tree.resolveActivity(getContext().getPackageManager()) != null) {
                getContext().startActivity(tree);
                call.resolve(result);
                return;
            }

            // 2) Google Files (Pixel) / DocumentsUI par nom de paquet.
            String[] managers = {
                    "com.google.android.apps.nbu.files",
                    "com.google.android.documentsui",
                    "com.android.documentsui"
            };
            for (String pkg : managers) {
                Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(pkg);
                if (launch == null) continue;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    launch.putExtra(DocumentsContract.EXTRA_INITIAL_URI, folder);
                }
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(launch);
                call.resolve(result);
                return;
            }

            // 3)ACTION_OPEN_DOCUMENT avec createChooser (dFeel galement le même
            // chemin que « Écouter ») : robuste si ACTION_OPEN_DOCUMENT_TREE
            // ne résout pas d'app cible.
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setData(folder);
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(view, "Ouvrir le dossier avec");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);
            call.resolve(result);
        } catch (Exception error) {
            result.put("error", "Ouverture du gestionnaire impossible : " + error.getMessage());
        }
        call.resolve(result);
    }

    /**
     * Supprime le fichier du stockage partagé. `uri` est l'URI MediaStore
     * conservée dans l'historique ; `name` sert de repli pour les entrées
     * anciennes ou quand l'URI n'est plus valide. Une suppression déjà
     * effectuée (fichier retiré depuis Fichiers) est un succès : le résultat
     * attendu est que le fichier ne soit plus là.
     */
    @PluginMethod
    public void deleteDownload(PluginCall call) {
        JSObject result = new JSObject();
        String uriText = call.getString("uri");
        String name = call.getString("name");
        android.content.Context context = getContext();
        boolean deleted = false;
        boolean safDocument = false;
        try {
            if (uriText != null && !uriText.isEmpty()) {
                Uri uri = Uri.parse(uriText);
                // MediaStore seulement : sur Android ≤ 9, l'URI FileProvider
                // ne sait pas supprimer et le repli par nom ci-dessous s'en
                // charge dans le dossier public.
                if ("media".equals(uri.getAuthority())) {
                    deleted = context.getContentResolver().delete(uri, null, null) > 0;
                } else if (DocumentsContract.isDocumentUri(context, uri)) {
                    // Dossier de réception choisi : suppression via SAF, qui
                    // exige l'autorisation persistée accordée au sélecteur.
                    safDocument = true;
                    deleted = DocumentsContract.deleteDocument(
                            context.getContentResolver(), uri);
                }
            }
            // Jamais de repli par nom pour une URI SAF : il pourrait supprimer
            // un homonyme dans Téléchargements/GlobalShare à sa place.
            if (!deleted && !safDocument && name != null && !name.isEmpty()) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    String selection = MediaStore.MediaColumns.DISPLAY_NAME + " = ? AND "
                            + MediaStore.MediaColumns.RELATIVE_PATH + " LIKE ?";
                    String[] args = {
                            name,
                            "%/" + Environment.DIRECTORY_DOWNLOADS + "/GlobalShare/%"
                    };
                    deleted = context.getContentResolver().delete(
                            MediaStore.Downloads.EXTERNAL_CONTENT_URI, selection, args) > 0;
                } else {
                    File dir = new File(Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS), "GlobalShare");
                    File file = new File(dir, name);
                    // Refuse un nom qui sortirait du dossier partagé.
                    if (file.getCanonicalFile().getParentFile() != null
                            && file.getCanonicalFile().getParentFile().equals(dir.getCanonicalFile())) {
                        deleted = file.isFile() && file.delete();
                    }
                }
            }
            result.put("deleted", true);
        } catch (SecurityException error) {
            result.put("error", "Android a refusé la suppression : " + error.getMessage());
        } catch (Exception error) {
            result.put("error", "Suppression impossible : " + error.getMessage());
        }
        call.resolve(result);
    }

    /**
     * Liste les fichiers RÉELLEMENT présents dans Téléchargements/GlobalShare
     * et dans les dossiers de réception déjà choisis par l'utilisateur.
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

            // Dossier de réception choisi dans les réglages : lister aussi son
            // contenu, sinon les fichiers qui y sont enregistrés disparaîtraient
            // de l'onglet « Sur cet appareil » (l'historique les croise avec
            // cette liste). Un dossier retiré ou une autorisation révoquée ne
            // doit pas casser la liste MediaStore : le repli est silencieux.
            for (String treeText : knownFolderTrees()) {
                try {
                    Uri chosen = Uri.parse(treeText);
                    Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(
                            chosen, DocumentsContract.getTreeDocumentId(chosen));
                    try (Cursor cursor = context.getContentResolver().query(
                            children,
                            new String[]{
                                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                                    DocumentsContract.Document.COLUMN_SIZE,
                                    DocumentsContract.Document.COLUMN_MIME_TYPE},
                            null, null, null)) {
                        if (cursor != null) {
                            while (cursor.moveToNext()) {
                                String id = cursor.getString(0);
                                String name = cursor.getString(1);
                                String mimeType = cursor.getString(3);
                                if (id == null || name == null) continue;
                                // Un dossier choisi (Téléchargements…) peut contenir
                                // des sous-dossiers : ce ne sont pas des fichiers reçus.
                                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)) continue;
                                JSObject item = new JSObject();
                                item.put("uri", DocumentsContract.buildDocumentUriUsingTree(
                                        chosen, id).toString());
                                item.put("name", name);
                                item.put("size", cursor.isNull(2) ? 0 : cursor.getLong(2));
                                files.put(item);
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // Dossier inaccessible : la liste par défaut reste servie.
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
