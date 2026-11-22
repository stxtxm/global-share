package io.github.stxtxm.globalshare;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Mises à jour in-app depuis les releases GitHub. Deux niveaux d'économie de
 * réseau, dans l'ordre :
 *
 * 1. Bundle web (systèmes des deux plateformes). La coquille native embarque
 *    l'export statique : si le manifeste `web-bundle.json` de la release
 *    annonce une `nativeVersion` identique à celle de l'APK installé, seule la
 *    couche web a changé. On télécharge alors `web-bundle.zip` (~1 Mo au lieu
 *    de ~80 Mo), on le vérifie, on l'extrait dans filesDir et on rebase le
 *    WebView dessus — sans réinstaller l'application.
 * 2. APK différentiel. Quand la coquille native change (nativeVersion ≠), le
 *    paquet complet est inévitable : le blockmap `.apk.blockmap` (empreintes
 *    SHA-256 par blocs de 64 Ko, voir scripts/apk-blockmap.mjs) permet
 *    néanmoins de ne demander au serveur que les blocs manquants via des
 *    requêtes HTTP Range, avec repli automatique sur le téléchargement complet.
 *
 * L'APK publié par le workflow Android est signé ; `$FILE.sha256` permet de
 * vérifier tout téléchargement (complet ou reconstruit) avant installation.
 */
final class UpdateManager {
    private static final String TAG = "GlobalShareUpdate";
    private static final String API =
            "https://api.github.com/repos/stxtxm/global-share/releases/latest";
    private static final String RELEASE_DOWNLOAD =
            "https://github.com/stxtxm/global-share/releases/latest/download";

    // Bundle web : mêmes limites que scripts/web-bundle.mjs ; tout dépassement
    // est un manifeste suspecté, jamais un vrai bundle.
    private static final long MAX_WEB_BUNDLE_BYTES = 256L * 1024 * 1024;
    private static final int MAX_WEB_BUNDLE_ENTRIES = 10_000;

    // Chargement différentiel : doit rester aligné sur scripts/apk-blockmap.mjs.
    private static final int BLOCK_SIZE = 64 * 1024;
    // En dessous de 40 % de blocs réutilisés, le delta ne vaut pas la complexité.
    private static final double MIN_REUSE_RATIO = 0.40;

    private static final String PREFS = "gsweb";
    private static final String PREF_VERSION = "webVersion";
    private static final String PREF_NATIVE = "webNative";
    private static final String PREF_DIR = "webDir";

    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "globalshare-update");
        thread.setDaemon(true);
        return thread;
    });

    private static Context context;
    private static volatile boolean checking;
    private static volatile boolean downloading;
    private static volatile String dismissedVersion;
    private static volatile String availableVersion;
    private static volatile String apkUrl;
    private static volatile String checksumUrl;
    private static volatile String blockmapUrl;
    private static volatile String expectedHash;
    private static volatile File downloadedApk;

    // Chemin « bundle web » : manifeste validé, en attente de téléchargement.
    private static volatile String pendingWebVersion;
    private static volatile String pendingWebSha256;
    private static volatile long pendingWebSize;

    private UpdateManager() {}

    static void init(Context applicationContext) {
        context = applicationContext.getApplicationContext();
    }

    static JSObject snapshot() {
        return UpdaterState.snapshot();
    }

    /**
     * Version effective : un bundle web appliqué compte plus que la coquille
     * installée ( BuildConfig.VERSION_NAME ). Sans cela, après un hot update,
     * la vérification suivante proposerait à l'infini la version déjà en place.
     */
    static String effectiveVersion() {
        try {
            String web = prefs().getString(PREF_VERSION, null);
            if (web != null && compareVersions(web, BuildConfig.VERSION_NAME) > 0) return web;
        } catch (Exception ignored) {
            // Pas de préférences lisibles : retour à la version de la coquille.
        }
        return BuildConfig.VERSION_NAME;
    }

    /** Dossier du bundle web actuellement appliqué, ou null si aucun. */
    private static File appliedWebDir() {
        try {
            SharedPreferences preferences = prefs();
            String version = preferences.getString(PREF_VERSION, null);
            String dir = preferences.getString(PREF_DIR, null);
            if (version == null || dir == null) return null;
            // nativeVersion doit toujours correspondre à la coquille : sinon le
            // bundle persisté est incompatible et on l'oublie (repli embeddé).
            if (preferences.getInt(PREF_NATIVE, -1) != BuildConfig.NATIVE_VERSION) return null;
            File folder = new File(dir);
            return folder.isDirectory() && folder.canRead() && new File(folder, "index.html").isFile()
                    ? folder
                    : null;
        } catch (Exception ignored) {
            return null;
        }
    }

    /** Dossier à servir dans le WebView : bundle appliqué si dispo, sinon null. */
    static File activeWebDir() {
        return appliedWebDir();
    }

    private static SharedPreferences prefs() {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // -----------------------------------------------------------------------
    // Vérification
    // -----------------------------------------------------------------------
    static void checkForUpdates(boolean manual) {
        if (checking || context == null) return;
        checking = true;
        if (manual) {
            dismissedVersion = null;
            UpdaterState.open();
        }
        patch("checking", null, 0, 0, 0, 0, "", "");

        EXECUTOR.execute(() -> {
            try {
                // 1) Manifeste du bundle web : une seule requête non
                //    rate-limitée (redirection GitHub vers l'asset le plus
                //    récent). Un échec n'est pas une erreur : on retombe sur
                //    le chemin historique (API + APK) ci-dessous.
                JSONObject manifest = fetchJsonOrNull(RELEASE_DOWNLOAD + "/web-bundle.json");
                if (manifest != null && tryWebUpdate(manifest)) return;

                // 2) Chemin complet : API GitHub, APK + blockmap.
                HttpURLConnection connection = open(API);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new IOException("HTTP " + connection.getResponseCode());
                }
                JSONObject release = new JSONObject(read(connection.getInputStream()));
                String version = versionFromTag(release.optString("tag_name", ""));
                if (version.isEmpty()) throw new IOException("Version de release introuvable.");

                apkUrl = null;
                checksumUrl = null;
                blockmapUrl = null;
                JSONArray assets = release.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.getJSONObject(i);
                        String name = asset.optString("name", "");
                        String url = asset.optString("browser_download_url", "");
                        if (url.isEmpty()) continue;
                        String lower = name.toLowerCase();
                        if (apkUrl == null && lower.endsWith(".apk")) apkUrl = url;
                        if (checksumUrl == null && lower.endsWith(".apk.sha256")) checksumUrl = url;
                        if (blockmapUrl == null && lower.endsWith(".apk.blockmap")) blockmapUrl = url;
                    }
                }
                if (apkUrl == null) throw new IOException("Aucun APK publié dans cette release.");

                availableVersion = version;
                expectedHash = checksumUrl == null ? null : readHash(checksumUrl);
                if (compareVersions(version, effectiveVersion()) <= 0) {
                    patch("up-to-date", null, 0, 0, 0, 0,
                            "GlobalShare est à jour (version " + effectiveVersion() + ").", "");
                } else if (version.equals(dismissedVersion)) {
                    patch("idle", null, 0, 0, 0, 0, "", "");
                } else {
                    patch("available", version, 0, 0, 0, 0,
                            "Version " + version + " disponible ("
                                    + effectiveVersion() + " installée).", "");
                }
            } catch (Exception error) {
                Log.w(TAG, "Vérification impossible", error);
                patch(manual ? "error" : "idle", null, 0, 0, 0, 0,
                        manual ? cleanMessage(error) : "", "");
            } finally {
                checking = false;
            }
        });
    }

    /**
     * Analyse le manifeste du bundle web. Renvoie vrai si la décision est
     * conclue (mise à jour web proposée, version déjà en place ou coquille
     * obsolète annoncée) ; faux pour laisser le chemin complet décider.
     */
    private static boolean tryWebUpdate(JSONObject manifest) {
        String version = manifest.optString("version", "");
        if (!version.matches("\\d+(\\.\\d+){1,3}")) return false;
        if (compareVersions(version, effectiveVersion()) <= 0) {
            if (isFullUpdateBelow(availableVersion)) return false;
            patch("up-to-date", null, 0, 0, 0, 0,
                    "GlobalShare est à jour (version " + effectiveVersion() + ").", "");
            return true;
        }
        int manifestNative = manifest.optInt("nativeVersion", -1);
        if (manifestNative != BuildConfig.NATIVE_VERSION) {
            // La même release embarque un paquet complet : on le laisse
            // décider (l'API annoncera la même version, mais une coquille neuve).
            return false;
        }
        String sha256 = manifest.optString("sha256", "").toLowerCase();
        long size = manifest.optLong("size", -1);
        if (!sha256.matches("[0-9a-f]{64}") || size <= 0 || size > MAX_WEB_BUNDLE_BYTES) return false;

        pendingWebVersion = version;
        pendingWebSha256 = sha256;
        pendingWebSize = size;
        availableVersion = version;
        if (version.equals(dismissedVersion)) return true; // non proposée, silencieux
        patch("available", version, 0, 0, size, 0,
                "Version " + version + " disponible — mise à jour rapide ("
                        + effectiveVersion() + " installée).", "web");
        return true;
    }

    /** Garde-fou : ne pas court-circuiter une annonce APK déjà préparée. */
    private static boolean isFullUpdateBelow(String version) {
        return version != null && compareVersions(version, effectiveVersion()) > 0;
    }

    // -----------------------------------------------------------------------
    // Téléchargement
    // -----------------------------------------------------------------------
    static void downloadUpdate() {
        if (downloading || context == null) return;
        if (pendingWebVersion != null) {
            downloadWebBundle();
            return;
        }
        if (apkUrl == null) return;
        downloading = true;
        patch("downloading", availableVersion, 0, 0, 0, 0,
                "Téléchargement de la mise à jour…", "");

        EXECUTOR.execute(() -> {
            File apk = null;
            try {
                String version = availableVersion == null ? "update" : availableVersion;
                File directory = new File(context.getCacheDir(), "update");
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IOException("Dossier de téléchargement indisponible.");
                }
                apk = new File(directory, "GlobalShare-" + version + ".apk");

                // Delta d'abord (blockmap + Range) ; repli automatique sur le
                // téléchargement complet au moindre doute.
                boolean done = false;
                if (blockmapUrl != null && expectedHash != null && !expectedHash.isEmpty()
                        && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                    try {
                        done = downloadDelta(apk, version);
                    } catch (Exception deltaError) {
                        Log.i(TAG, "Delta impossible, téléchargement complet", deltaError);
                        done = false;
                    }
                }
                if (!done) downloadStream(apk, apkUrl, version, 0, "");

                if (!isApk(apk)) throw new IOException("Le fichier téléchargé n'est pas un APK.");
                if (expectedHash != null && !expectedHash.isEmpty()) {
                    String actual = sha256Hex(apk);
                    if (!actual.equalsIgnoreCase(expectedHash)) {
                        throw new IOException("Empreinte SHA-256 différente de celle de la release.");
                    }
                }

                downloadedApk = apk;
                patch("downloaded", version, 100, apk.length(), apk.length(), 0,
                        version + " est prête à installer.", "");
            } catch (Exception error) {
                Log.w(TAG, "Téléchargement impossible", error);
                if (apk != null && apk.exists() && !apk.delete()) apk.deleteOnExit();
                downloadedApk = null;
                patch("error", availableVersion, 0, 0, 0, 0, cleanMessage(error), "");
            } finally {
                downloading = false;
            }
        });
    }

    /** Bundle web : zip de l'export statique, vérifié puis extrait. */
    private static void downloadWebBundle() {
        downloading = true;
        final String version = pendingWebVersion;
        final String sha256 = pendingWebSha256;
        final long size = pendingWebSize;
        patch("downloading", version, 0, 0, size, 0,
                "Téléchargement de la mise à jour…", "web");

        EXECUTOR.execute(() -> {
            File zip = null;
            File target = null;
            File staging = null;
            try {
                File directory = new File(context.getFilesDir(), "web");
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IOException("Dossier des bundles indisponible.");
                }
                zip = new File(context.getCacheDir(), "web-bundle-" + version + ".zip");
                staging = new File(directory, version + ".staging");

                downloadStream(zip, RELEASE_DOWNLOAD + "/web-bundle.zip", version, size, "web");

                // L'empreinte est obligatoire ici : ces fichiers remplaceront
                // ceux embarqués dans l'APK.
                if (sha256 == null || !sha256Hex(zip).equalsIgnoreCase(sha256)) {
                    throw new IOException("Empreinte SHA-256 du bundle web différente du manifeste.");
                }

                extractZip(zip, staging);
                if (!new File(staging, "index.html").isFile()) {
                    throw new IOException("Bundle web incomplet (index.html manquant).");
                }
                target = new File(directory, version);
                deleteRecursively(target);
                if (!staging.renameTo(target)) throw new IOException("Extraction finalisée impossible : renommage refusé.");

                patch("downloaded", version, 100, target.length(), target.length(), 0,
                        version + " est prête à installer (sans réinstallation).", "web");
            } catch (Exception error) {
                Log.w(TAG, "Téléchargement du bundle impossible", error);
                if (staging != null) deleteRecursively(staging);
                if (zip != null && zip.exists() && !zip.delete()) zip.deleteOnExit();
                pendingWebVersion = null;
                patch("error", version, 0, 0, 0, 0, cleanMessage(error), "web");
            } finally {
                if (zip != null && zip.exists() && zip.delete()) { /* nettoyé */ }
                downloading = false;
            }
        });
    }

    /** Copie locale du flux de téléchargement générique avec progression. */
    private static void downloadStream(File target, String url, String version, long announcedSize,
                                       String mode) throws IOException {
        patch("downloading", version, 0, 0, announcedSize, 0,
                "Téléchargement de la mise à jour…", mode);
        HttpURLConnection connection = open(url);
        if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
            throw new IOException("HTTP " + connection.getResponseCode());
        }
        long total = connection.getContentLengthLong() > 0
                ? connection.getContentLengthLong()
                : announcedSize;
        long transferred = 0;
        long lastTime = System.currentTimeMillis();
        long lastBytes = 0;
        try (InputStream input = connection.getInputStream();
             FileOutputStream output = new FileOutputStream(target, false)) {
            byte[] buffer = new byte[16384];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
                transferred += count;
                long now = System.currentTimeMillis();
                if (now - lastTime >= 200) {
                    long speed = (transferred - lastBytes) * 1000L / Math.max(1L, now - lastTime);
                    int percent = total > 0 ? (int) Math.min(100L, transferred * 100L / total) : 0;
                    patch("downloading", version, percent, transferred, total, speed,
                            "Téléchargement de la mise à jour…", mode);
                    lastTime = now;
                    lastBytes = transferred;
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // Téléchargement différentiel de l'APK (blockmap)
    // -----------------------------------------------------------------------
    /**
     * Reconstruit l'APK de la release en réutilisant les blocs de l'APK
     * installé dont l'empreinte correspond, et en demandant les autres au
     * serveur via des requêtes Range. Renvoie vrai si l'APK est complet ; faux
     * si le delta ne vaut pas la peine (moins de {@link #MIN_REUSE_RATIO} de
     * blocs communs) pour retomber sur le téléchargement complet.
     */
    private static boolean downloadDelta(File apk, String version) throws IOException {
        JSONObject blockmap = fetchJsonOrNull(blockmapUrl);
        if (blockmap == null || blockmap.optInt("version", -1) != 1) return false;
        long fileSize = blockmap.optLong("fileSize", -1);
        int blockSize = blockmap.optInt("blockSize", -1);
        JSONArray blocks = blockmap.optJSONArray("blocks");
        if (fileSize <= 0 || blockSize != BLOCK_SIZE || blocks == null || blocks.length() == 0) return false;
        int totalBlocks = blocks.length();
        // Dernier bloc partiel : la taille du fichier fait foie.
        if ((long) (totalBlocks - 1) * blockSize >= fileSize) return false;

        String sourcePath = context.getApplicationInfo().sourceDir;
        if (sourcePath == null) return false;
        Map<String, Long> sourceOffsets = new HashMap<>();
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (RandomAccessFile source = new RandomAccessFile(sourcePath, "r")) {
                byte[] block = new byte[blockSize];
                int blockIndex = 0;
                while (true) {
                    long offset = (long) blockIndex * blockSize;
                    if (offset >= source.length()) break;
                    source.seek(offset);
                    int read = source.read(block);
                    if (read <= 0) break;
                    // Le blockmap publie des empreintes base64 (scripts/apk-blockmap.mjs).
                    sourceOffsets.putIfAbsent(
                            Base64.getEncoder().encodeToString(digest.digest(trimTo(block, read))),
                            offset);
                    if (blockIndex > totalBlocks * 2) break; // sécurité : source démultipliée
                    blockIndex += 1;
                }
            }
        } catch (Exception error) {
            Log.i(TAG, "Lecture de l'APK installé impossible", error);
            return false;
        }

        // On borne le travail : quel bloc existe déjà, lesquels manquent.
        List<int[]> missing = new ArrayList<>(); // [index de bloc, longueur]
        int reused = 0;
        for (int index = 0; index < totalBlocks; index++) {
            long offset = (long) index * blockSize;
            int length = (int) Math.min(blockSize, fileSize - offset);
            if (sourceOffsets.containsKey(blocks.optString(index, ""))) reused += 1;
            else missing.add(new int[]{index, length});
        }
        if ((double) reused / totalBlocks < MIN_REUSE_RATIO) {
            Log.i(TAG, "Delta peu rentable : " + reused + "/" + totalBlocks + " blocs communs");
            return false;
        }

        // On reconstruit : blocs copiés localement, plages manquantes ensuite.
        patch("downloading", version, 0, 0, fileSize, 0,
                "Mise à jour rapide : " + reused + "/" + totalBlocks + " blocs réutilisés…", "");
        try (RandomAccessFile source = new RandomAccessFile(sourcePath, "r");
             RandomAccessFile output = new RandomAccessFile(apk, "rw")) {
            output.setLength(fileSize);
            byte[] buffer = new byte[BLOCK_SIZE];
            for (int index = 0; index < totalBlocks; index++) {
                long offset = (long) index * blockSize;
                int length = (int) Math.min(blockSize, fileSize - offset);
                Long sourceOffset = sourceOffsets.get(blocks.optString(index, ""));
                if (sourceOffset == null) continue;
                source.seek(sourceOffset);
                int read = source.read(buffer, 0, length);
                if (read != length) throw new IOException("Bloc source incomplet (" + index + ").");
                output.seek(offset);
                output.write(buffer, 0, length);
            }
        }

        if (missing.size() > 0 && !fetchMissingRanges(apk, apkUrl, missing, version,
                fileSize, totalBlocks, reused)) {
            return false; // plages refusées : le tampon est inutilisable
        }
        return true;
    }

    /** Demande les plages manquantes au serveur, une requête Range par bloc. */
    private static boolean fetchMissingRanges(File apk, String url, List<int[]> missing,
                                              String version, long fileSize, int totalBlocks,
                                              int reusedBlocks) throws IOException {
        // HttpURLConnection repose la requête sans Range après redirection :
        // on suit le saut manuellement pour préserver l'en-tête.
        String rangeUrl = resolveRedirect(url);
        if (rangeUrl == null) return false;

        // La lecture par plage se fait par blocs de 64 Ko, comme la copie locale.
        byte[] buffer = new byte[BLOCK_SIZE];
        long downloaded = 0;
        long start = System.currentTimeMillis();
        int done = 0;
        for (int[] range : missing) {
            long first = (long) range[0] * BLOCK_SIZE;
            int length = range[1];
            HttpURLConnection connection = rangeRequest(rangeUrl, first, length);
            try {
                if (connection.getResponseCode() != HttpURLConnection.HTTP_PARTIAL) return false;
                try (InputStream input = connection.getInputStream();
                     RandomAccessFile output = new RandomAccessFile(apk, "rw")) {
                    output.seek(first);
                    int remaining = length;
                    while (remaining > 0) {
                        int read = input.read(buffer, 0, Math.min(buffer.length, remaining));
                        if (read <= 0) throw new IOException("Plage tronquée (bloc " + range[0] + ").");
                        output.write(buffer, 0, read);
                        remaining -= read;
                        downloaded += read;
                        long now = System.currentTimeMillis();
                        if (now - start >= 200) {
                            long copied = reusedBlocks * (long) BLOCK_SIZE;
                            long transferred = Math.min(fileSize, copied + downloaded);
                            int percent = (int) Math.min(100L, transferred * 100L / fileSize);
                            patch("downloading", version, percent, transferred, fileSize,
                                    downloaded * 1000L / Math.max(1L, now - start),
                                    "Blocs manquants : " + (done + 1) + "/" + missing.size(), "");
                            start = now;
                        }
                    }
                }
                done += 1;
            } finally {
                connection.disconnect();
            }
        }
        return true;
    }

    /** Suit une seule redirection (GitHub → CDN) et renvoie l'URL finale. */
    private static String resolveRedirect(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent",
                "GlobalShare-Android/" + BuildConfig.VERSION_NAME);
        int code = connection.getResponseCode();
        if (code >= 300 && code < 400) {
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            return location != null ? location : url;
        }
        return code == HttpURLConnection.HTTP_OK ? url : null;
    }

    private static HttpURLConnection rangeRequest(String url, long first, int length)
            throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("User-Agent",
                "GlobalShare-Android/" + BuildConfig.VERSION_NAME);
        connection.setRequestProperty("Range", "bytes=" + first + "-" + (first + length - 1));
        return connection;
    }

    // -----------------------------------------------------------------------
    // Installation
    // -----------------------------------------------------------------------
    static void installUpdate(Activity activity) {
        installUpdate(activity, null);
    }

    /**
     * @param applyWeb callback notifié du dossier du bundle web appliqué ;
     *                 MainActivity passe le rebasage du WebView.
     */
    static void installUpdate(Activity activity, java.util.function.Consumer<String> applyWeb) {
        if (pendingWebVersion != null) {
            applyWebBundle(pendingWebVersion, applyWeb);
            return;
        }

        File apk = downloadedApk;
        if (apk == null || !apk.exists()) {
            patch("error", availableVersion, 0, 0, 0, 0,
                    "Le paquet téléchargé est introuvable. Relancez le téléchargement.", "");
            return;
        }
        // Android 8+ : installer un APK hors du Play Store demande le consentement
        // « sources inconnues », à accorder une fois pour l'application.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !context.getPackageManager().canRequestPackageInstalls()) {
            try {
                Intent settings = new Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                activity.startActivity(settings);
            } catch (Exception ignored) {
                // Certains launchers ne gèrent pas cet écran : le message reste affiché.
            }
            patch("downloaded", availableVersion, 100, 0, 0, 0,
                    "Autorisez GlobalShare à installer des applications inconnues, "
                            + "puis appuyez de nouveau sur « Installer et redémarrer ».", "");
            UpdaterState.open();
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                    context, context.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
            patch("installing", availableVersion, 100, 0, 0, 0,
                    "Installation en cours…", "");
        } catch (Exception error) {
            patch("error", availableVersion, 0, 0, 0, 0, cleanMessage(error), "");
        }
    }

    /**
     * Persiste le bundle web puis le fait servir au WebView : aucun redémarrage
     * d'application, aucune réinstallation, aucun consentement nouveau.
     */
    private static void applyWebBundle(String version, java.util.function.Consumer<String> applyWeb) {
        patch("installing", version, 0, 0, 0, 0, "Application de la mise à jour…", "web");
        File target = new File(new File(context.getFilesDir(), "web"), version);
        if (!new File(target, "index.html").isFile()) {
            pendingWebVersion = null;
            patch("error", version, 0, 0, 0, 0,
                    "Le bundle téléchargé est introuvable. Relancez le téléchargement.", "web");
            return;
        }
        prefs().edit()
                .putString(PREF_VERSION, version)
                .putInt(PREF_NATIVE, BuildConfig.NATIVE_VERSION)
                .putString(PREF_DIR, target.getAbsolutePath())
                .apply();
        pendingWebVersion = null;
        dismissedVersion = null;
        pruneOldWebBundles(version);
        patch("up-to-date", version, 0, 0, 0, 0,
                "GlobalShare " + version + " est appliquée.", "web");
        if (applyWeb != null) {
            try {
                applyWeb.accept(target.getAbsolutePath());
            } catch (Exception error) {
                Log.w(TAG, "Rebasage du WebView impossible", error);
            }
        }
    }

    /** Supprime les bundles web remplacés (et les extractions incomplètes). */
    private static void pruneOldWebBundles(String keepVersion) {
        File root = new File(context.getFilesDir(), "web");
        File[] entries = root.listFiles();
        if (entries == null) return;
        for (File entry : entries) {
            if (entry.getName().equals(keepVersion)) continue;
            deleteRecursively(entry);
        }
    }

    static void dismiss() {
        if ("available".equals(currentStatus()) || "downloaded".equals(currentStatus())) {
            dismissedVersion = availableVersion;
        }
        patch("idle", availableVersion, 0, 0, 0, 0, "", "");
    }

    private static String currentStatus() {
        try {
            return UpdaterState.snapshot().optString("status", "idle");
        } catch (Exception ignored) {
            return "idle";
        }
    }

    // -----------------------------------------------------------------------
    // Utilitaires réseau, fichiers et versions
    // -----------------------------------------------------------------------
    private static void patch(String status, String version, int percent, long transferred,
                              long total, long bytesPerSecond, String message, String mode) {
        UpdaterState.patch(new UpdaterState.JSONObjectPatch()
                .put("status", status)
                .put("version", version == null ? effectiveVersion() : version)
                .put("currentVersion", effectiveVersion())
                .put("percent", Math.max(0, Math.min(100, percent)))
                .put("transferred", Math.max(0, transferred))
                .put("total", Math.max(0, total))
                .put("bytesPerSecond", Math.max(0, bytesPerSecond))
                .put("requiresAdmin", false)
                .put("mode", mode == null ? "" : mode)
                .put("message", message == null ? "" : message));
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("User-Agent", "GlobalShare-Android/" + BuildConfig.VERSION_NAME);
        connection.setRequestProperty("Accept", "application/vnd.github+json");
        return connection;
    }

    private static String read(InputStream input) throws IOException {
        StringBuilder text = new StringBuilder();
        byte[] buffer = new byte[4096];
        int count;
        while ((count = input.read(buffer)) != -1) {
            text.append(new String(buffer, 0, count, StandardCharsets.UTF_8));
        }
        input.close();
        return text.toString();
    }

    private static JSONObject fetchJsonOrNull(String url) {
        try {
            HttpURLConnection connection = open(url);
            connection.setRequestProperty("Accept", "application/json");
            connection.setReadTimeout(15000);
            if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
            String body = read(connection.getInputStream());
            return body.isEmpty() ? null : new JSONObject(body);
        } catch (Exception error) {
            Log.i(TAG, "Ressource indisponible : " + url, error);
            return null;
        }
    }

    private static String readHash(String url) throws IOException {
        HttpURLConnection connection = open(url);
        if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
        String text = read(connection.getInputStream()).trim();
        int space = text.indexOf(' ');
        return space > 0 ? text.substring(0, space) : text;
    }

    private static String sha256Hex(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        return hex(digest.digest());
    }

    /** Extraction zip bornée : refuse les entrées hors du dossier cible. */
    private static void extractZip(File zip, File destination) throws IOException {
        if (destination.exists() && !deleteRecursively(destination)) {
            throw new IOException("Dossier d'extraction indisponible.");
        }
        if (!destination.mkdirs()) throw new IOException("Dossier d'extraction indisponible.");
        String canonicalRoot = destination.getCanonicalPath() + File.separator;
        long totalWritten = 0;
        int entries = 0;
        try (ZipInputStream input = new ZipInputStream(new FileInputStream(zip))) {
            ZipEntry entry;
            while ((entry = input.getNextEntry()) != null) {
                if (++entries > MAX_WEB_BUNDLE_ENTRIES) throw new IOException("Trop d'entrées dans le bundle.");
                String name = entry.getName();
                if (name.startsWith("/") || name.contains("..")) {
                    throw new IOException("Entrée suspecte dans l'archive : " + name);
                }
                File target = new File(destination, name);
                if (!target.getCanonicalPath().startsWith(canonicalRoot) && !target.getCanonicalPath().equals(destination.getCanonicalPath())) {
                    throw new IOException("Entrée hors du bundle : " + name);
                }
                if (entry.isDirectory()) {
                    target.mkdirs();
                    continue;
                }
                File parent = target.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("Dossier d'entrée indisponible : " + name);
                }
                long written = 0;
                try (FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[16384];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        written += count;
                        totalWritten += count;
                        if (totalWritten > MAX_WEB_BUNDLE_BYTES) throw new IOException("Bundle trop volumineux.");
                        output.write(buffer, 0, count);
                    }
                }
                if (written != entry.getSize() && entry.getSize() >= 0) {
                    throw new IOException("Entrée incomplète : " + name);
                }
            }
        }
    }

    private static boolean deleteRecursively(File file) {
        if (file == null || !file.exists()) return true;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteRecursively(child);
        }
        return file.delete();
    }

    private static String versionFromTag(String tag) {
        String value = tag == null ? "" : tag.trim();
        if (value.startsWith("v")) value = value.substring(1);
        int dash = value.indexOf('-');
        if (dash > 0) value = value.substring(0, dash);
        return value.matches("\\d+(\\.\\d+){1,3}") ? value : "";
    }

    private static int compareVersions(String left, String right) {
        int[] a = parts(left);
        int[] b = parts(right);
        for (int i = 0; i < 3; i++) {
            if (a[i] != b[i]) return a[i] > b[i] ? 1 : -1;
        }
        return 0;
    }

    private static int[] parts(String version) {
        int[] result = new int[3];
        String[] split = version.split("\\.");
        for (int i = 0; i < Math.min(3, split.length); i++) {
            try {
                result[i] = Integer.parseInt(split[i]);
            } catch (NumberFormatException ignored) {
                result[i] = 0;
            }
        }
        return result;
    }

    private static boolean isApk(File file) throws IOException {
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] magic = new byte[4];
            if (input.read(magic) != 4) return false;
            return magic[0] == 'P' && magic[1] == 'K' && magic[2] == 3 && magic[3] == 4;
        }
    }

    private static byte[] trimTo(byte[] source, int length) {
        if (length == source.length) return source;
        byte[] trimmed = new byte[length];
        System.arraycopy(source, 0, trimmed, 0, length);
        return trimmed;
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format("%02x", value));
        return result.toString();
    }

    private static String cleanMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isEmpty()
                ? "La mise à jour a échoué."
                : message.length() > 400 ? message.substring(0, 400) : message;
    }
}
