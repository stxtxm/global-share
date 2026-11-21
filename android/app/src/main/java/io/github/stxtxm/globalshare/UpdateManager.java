package io.github.stxtxm.globalshare;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
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
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Mises à jour in-app depuis les releases GitHub. L'APK publié par le workflow
 * Android est signé ; un fichier `.apk.sha256` accompagnant l'asset permet de
 * vérifier le téléchargement avant de proposer l'installation.
 */
final class UpdateManager {
    private static final String TAG = "GlobalShareUpdate";
    private static final String API =
            "https://api.github.com/repos/stxtxm/global-share/releases/latest";

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
    private static volatile String expectedHash;
    private static volatile File downloadedApk;

    private UpdateManager() {}

    static void init(Context applicationContext) {
        context = applicationContext.getApplicationContext();
    }

    static JSObject snapshot() {
        return UpdaterState.snapshot();
    }

    static void checkForUpdates(boolean manual) {
        if (checking || context == null) return;
        checking = true;
        if (manual) {
            dismissedVersion = null;
            UpdaterState.open();
        }
        patch("checking", null, 0, 0, 0, 0, "");

        EXECUTOR.execute(() -> {
            try {
                HttpURLConnection connection = open(API);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new IOException("HTTP " + connection.getResponseCode());
                }
                JSONObject release = new JSONObject(read(connection.getInputStream()));
                String version = versionFromTag(release.optString("tag_name", ""));
                if (version.isEmpty()) throw new IOException("Version de release introuvable.");

                apkUrl = null;
                checksumUrl = null;
                JSONArray assets = release.optJSONArray("assets");
                if (assets != null) {
                    for (int i = 0; i < assets.length(); i++) {
                        JSONObject asset = assets.getJSONObject(i);
                        String name = asset.optString("name", "");
                        String url = asset.optString("browser_download_url", "");
                        if (url.isEmpty()) continue;
                        if (apkUrl == null && name.toLowerCase().endsWith(".apk")) apkUrl = url;
                        if (checksumUrl == null && name.toLowerCase().endsWith(".apk.sha256")) {
                            checksumUrl = url;
                        }
                    }
                }
                if (apkUrl == null) throw new IOException("Aucun APK publié dans cette release.");

                availableVersion = version;
                expectedHash = checksumUrl == null ? null : readHash(checksumUrl);
                if (compareVersions(version, BuildConfig.VERSION_NAME) <= 0) {
                    patch("up-to-date", null, 0, 0, 0, 0,
                            "GlobalShare est à jour (version " + BuildConfig.VERSION_NAME + ").");
                } else if (version.equals(dismissedVersion)) {
                    patch("idle", null, 0, 0, 0, 0, "");
                } else {
                    patch("available", version, 0, 0, 0, 0,
                            "Version " + version + " disponible ("
                                    + BuildConfig.VERSION_NAME + " installée).");
                }
            } catch (Exception error) {
                Log.w(TAG, "Vérification impossible", error);
                patch(manual ? "error" : "idle", null, 0, 0, 0, 0,
                        manual ? cleanMessage(error) : "");
            } finally {
                checking = false;
            }
        });
    }

    static void downloadUpdate() {
        if (downloading || apkUrl == null || context == null) return;
        downloading = true;
        patch("downloading", availableVersion, 0, 0, 0, 0,
                "Téléchargement de la mise à jour…");

        EXECUTOR.execute(() -> {
            File apk = null;
            try {
                String version = availableVersion == null ? "update" : availableVersion;
                File directory = new File(context.getCacheDir(), "update");
                if (!directory.exists() && !directory.mkdirs()) {
                    throw new IOException("Dossier de téléchargement indisponible.");
                }
                apk = new File(directory, "GlobalShare-" + version + ".apk");

                HttpURLConnection connection = open(apkUrl);
                if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) {
                    throw new IOException("HTTP " + connection.getResponseCode());
                }
                long total = connection.getContentLengthLong();
                long transferred = 0;
                long lastTime = System.currentTimeMillis();
                long lastBytes = 0;
                MessageDigest digest = MessageDigest.getInstance("SHA-256");

                try (InputStream input = connection.getInputStream();
                     FileOutputStream output = new FileOutputStream(apk, false)) {
                    byte[] buffer = new byte[16384];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                        digest.update(buffer, 0, count);
                        transferred += count;
                        long now = System.currentTimeMillis();
                        if (now - lastTime >= 200) {
                            long speed = (transferred - lastBytes) * 1000L
                                    / Math.max(1L, now - lastTime);
                            int percent = total > 0
                                    ? (int) Math.min(100L, transferred * 100L / total)
                                    : 0;
                            patch("downloading", version, percent, transferred, total, speed,
                                    "Téléchargement de la mise à jour…");
                            lastTime = now;
                            lastBytes = transferred;
                        }
                    }
                }

                if (!isApk(apk)) throw new IOException("Le fichier téléchargé n'est pas un APK.");
                if (expectedHash != null && !expectedHash.isEmpty()) {
                    String actual = hex(digest.digest());
                    if (!actual.equalsIgnoreCase(expectedHash)) {
                        throw new IOException("Empreinte SHA-256 différente de celle de la release.");
                    }
                }

                downloadedApk = apk;
                patch("downloaded", version, 100, transferred, total, 0,
                        version + " est prête à installer.");
            } catch (Exception error) {
                Log.w(TAG, "Téléchargement impossible", error);
                if (apk != null && apk.exists() && !apk.delete()) apk.deleteOnExit();
                downloadedApk = null;
                patch("error", availableVersion, 0, 0, 0, 0, cleanMessage(error));
            } finally {
                downloading = false;
            }
        });
    }

    static void installUpdate(Activity activity) {
        File apk = downloadedApk;
        if (apk == null || !apk.exists()) {
            patch("error", availableVersion, 0, 0, 0, 0,
                    "Le paquet téléchargé est introuvable. Relancez le téléchargement.");
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
                            + "puis appuyez de nouveau sur « Installer et redémarrer ».");
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
                    "Installation en cours…");
        } catch (Exception error) {
            patch("error", availableVersion, 0, 0, 0, 0, cleanMessage(error));
        }
    }

    static void dismiss() {
        if ("available".equals(currentStatus()) || "downloaded".equals(currentStatus())) {
            dismissedVersion = availableVersion;
        }
        patch("idle", availableVersion, 0, 0, 0, 0, "");
    }

    private static String currentStatus() {
        try {
            return UpdaterState.snapshot().optString("status", "idle");
        } catch (Exception ignored) {
            return "idle";
        }
    }

    private static void patch(String status, String version, int percent, long transferred,
                              long total, long bytesPerSecond, String message) {
        UpdaterState.patch(new UpdaterState.JSONObjectPatch()
                .put("status", status)
                .put("version", version == null ? BuildConfig.VERSION_NAME : version)
                .put("currentVersion", BuildConfig.VERSION_NAME)
                .put("percent", Math.max(0, Math.min(100, percent)))
                .put("transferred", Math.max(0, transferred))
                .put("total", Math.max(0, total))
                .put("bytesPerSecond", Math.max(0, bytesPerSecond))
                .put("requiresAdmin", false)
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

    private static String readHash(String url) throws IOException {
        HttpURLConnection connection = open(url);
        if (connection.getResponseCode() != HttpURLConnection.HTTP_OK) return null;
        String text = read(connection.getInputStream()).trim();
        int space = text.indexOf(' ');
        return space > 0 ? text.substring(0, space) : text;
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
