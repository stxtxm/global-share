package io.github.stxtxm.globalshare;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Maintient la session quand l'app part en arrière-plan ou que l'écran se
 * verrouille : notification permanente (service avant-plan), wake lock CPU et
 * verrou Wi-Fi. Deux sources de demande cohabitent :
 *
 * - « keepAlive » : la session est ouverte et connectée ; le socket du WebView
 *   doit rester actif, transfert en cours ou pas (sinon l'appareil s'endort,
 *   la socket tombe et les pairs nous voient partir). Réaffirmé : l'app est
 *   revenue au premier plan ou a quitté le salon → l'UI envoie keepAlive=false.
 * - Les transferts : compteur affiché dans la notification (envoi et réception
 *   passent par le même compteur web).
 *
 * Le service ne s'arrête que quand les deux sont à zéro. Si Android tue quand
 * même le WebView, la reprise IndexedDB repart au dernier chunk.
 *
 * Fermer l'app (balayage hors des applications récentes, bouton Retour)
 * arrête toujours le service. Tout le transfert vit dans le WebView, qui est
 * détruit avec la tâche : le service ne pouvait donc plus rien faire avancer,
 * il ne restait que sa notification. La reprise se fait à la réouverture, à
 * partir des chunks conservés en IndexedDB (`app/lib/resume-store.ts`). Le
 * booléen `detached` empêche un appel JS tardif de rallumer le service entre
 * la fermeture et la recréation de l'activité (`attach`).
 */
public final class TransferForegroundService extends Service {
    public static final String ACTION_STOP =
            "io.github.stxtxm.globalshare.TRANSFER_STOP";

    private static final String CHANNEL_ID = "globalshare-transfer";
    private static final int NOTIFICATION_ID = 1001;

    private static volatile int activeTransfers;
    private static volatile int progress;
    private static volatile boolean keepAlive;
    /**
     * L'interface a disparu (Retour, balayage) et le service a été arrêté :
     * un appel JS encore en vol ne doit pas le rallumer. Seul `attach()`, à la
     * recréation de l'activité, lève ce drapeau.
     */
    private static volatile boolean detached;

    /** Le plugin relaie ce tick vers le WebView pour battre le throttling JS. */
    public interface TickListener { void onTick(); }
    private static volatile TickListener tickListener;

    public static void setTickListener(TickListener listener) {
        tickListener = listener;
    }

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private final Handler watchdog = new Handler(Looper.getMainLooper());
    private final Runnable watchdogTick = new Runnable() {
        @Override
        public void run() {
            try {
                // Un lock perdu (ROM agressive, service recréé) est repris ici.
                acquireLocks();
                showNotification();
                TickListener listener = tickListener;
                if (listener != null) listener.onTick();
            } catch (Exception ignored) {
                // Le service doit survivre à une erreur ponctuelle de notification.
            }
            watchdog.postDelayed(this, 10_000);
        }
    };

    /** Session à maintenir : demandée par le salon et interface encore ouverte. */
    private static boolean sessionActive() {
        return keepAlive && !detached;
    }

    /** Session salon connectée : la connexion doit survivre à l'arrière-plan. */
    public static void setKeepAlive(Context context, boolean enabled) {
        if (detached) return;
        keepAlive = enabled;
        if (enabled) {
            requestStart(context);
        } else if (activeTransfers == 0) {
            stopService(context);
        }
    }

    public static void start(Context context, int count, int percent) {
        if (detached) return;
        activeTransfers = Math.max(1, count);
        progress = clamp(percent);
        requestStart(context);
    }

    public static void update(Context context, int count, int percent) {
        if (count <= 0) {
            finishTransfers(context);
            return;
        }
        if (detached) return;
        activeTransfers = count;
        progress = clamp(percent);
        requestStart(context);
    }

    /**
     * Dernier transfert terminé : le service s'arrête de lui-même s'il n'a plus
     * de session à maintenir (app fermée ou salon quitté). C'est ce chemin qui
     * retire la notification après la fermeture de l'app pendant un transfert.
     */
    private static void finishTransfers(Context context) {
        activeTransfers = 0;
        progress = 0;
        if (!sessionActive()) {
            stopService(context);
            return;
        }
        // Session toujours ouverte : on ne garde que la connexion.
        requestStart(context);
    }

    /** Arrêt demandé par l'UI (sortie du salon) : plus rien à maintenir. */
    public static void stop(Context context) {
        activeTransfers = 0;
        progress = 0;
        keepAlive = false;
        // L'interface est vivante : elle pourra redemander le service.
        detached = false;
        stopService(context);
    }

    /**
     * L'interface disparaît : bouton Retour (`MainActivity.onDestroy`) ou
     * balayage hors des applications récentes (`onTaskRemoved`). Le WebView
     * étant détruit avec la tâche, plus aucun transfert ne peut avancer : le
     * service s'arrête toujours, et sa notification avec. `detached` reste
     * posé pour qu'un appel JS encore en vol ne le rallume pas ; le transfert
     * reprend depuis IndexedDB à la réouverture de l'app.
     */
    public static void detach(Context context) {
        keepAlive = false;
        activeTransfers = 0;
        progress = 0;
        detached = true;
        stopService(context);
    }

    /** L'interface est de retour (activité recréée) : le salon peut re-demander. */
    public static void attach() {
        detached = false;
    }

    public static boolean isRunning() {
        return !detached && (keepAlive || activeTransfers > 0);
    }

    public static boolean isBatteryOptimized(android.content.Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && !power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(100, value));
    }

    /**
     * Démarre le service sans laisser un refus système remonter dans la boucle
     * principale : Android 12+ interdit un service avant-plan lancé depuis
     * l'arrière-plan (`ForegroundServiceStartNotAllowedException`). L'instance
     * déjà vivante suffit dans ce cas, elle rafraîchit sa notification.
     */
    private static void requestStart(Context context) {
        try {
            ContextCompat.startForegroundService(
                    context, new Intent(context, TransferForegroundService.class));
        } catch (Exception ignored) {
            // Refus système : état statique conservé, prochain tick au premier plan.
        }
    }

    private static void stopService(Context context) {
        try {
            context.stopService(new Intent(context, TransferForegroundService.class));
        } catch (Exception ignored) {
            // Service déjà arrêté : rien à faire.
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            createChannel();
        } catch (Exception ignored) {
            // Canal déjà créé ou NotificationManager indisponible.
        }
        acquireLocks();
        // Tick natif : les timers du WebView sont bridés à 1/min après 5 min
        // masqués (Chrome 88+), même avec un PARTIAL_WAKE_LOCK. Ce tick, lui,
        // tourne tant que le service est vivant et pilote la reprise côté JS.
        watchdog.postDelayed(watchdogTick, 10_000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Relance par le système sans intention (processus tué) : plus aucun
        // WebView ne pilote le service, une notification « Connectée » ou
        // « Transfert en cours » resterait affichée indéfiniment, app fermée.
        if (intent == null) {
            shutdown();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        // Interface fermée entre-temps : l'appel a été émis avant `detach`,
        // il ne doit pas rallumer la notification.
        if (detached) {
            shutdown();
            return START_NOT_STICKY;
        }
        acquireLocks();
        try {
            showNotification();
        } catch (Exception error) {
            // startForeground refusé (type non autorisé, arrière-plan) : un
            // service qui n'a pas pu se déclarer au premier plan doit
            // s'arrêter, sinon Android lève une ANR « did not call
            // startForeground ». On sort proprement, sans crash.
            shutdown();
            return START_NOT_STICKY;
        }
        // Jamais START_STICKY : un service relancé sans WebView ne peut plus
        // rien faire et laissait sa notification en place pour toujours.
        return START_NOT_STICKY;
    }

    /**
     * L'utilisateur retire l'app des applications récentes : le WebView qui
     * demandait le maintien du salon n'existe plus, le service s'arrête.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        detach(this);
        super.onTaskRemoved(rootIntent);
    }

    /** Arrêt complet : état statique, notification, verrous et service. */
    private void shutdown() {
        activeTransfers = 0;
        progress = 0;
        keepAlive = false;
        // `detached` n'est pas remis à zéro ici : c'est ce qui empêche un appel
        // JS tardif de relancer le service après la fermeture. Seul `attach()`
        // (activité recréée) le lève.
        watchdog.removeCallbacks(watchdogTick);
        releaseLocks();
        try {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
            // Service déjà retiré du premier plan : rien à retirer.
        }
        stopSelf();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
                (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, "Transferts de fichiers", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Maintient la session et les transferts actifs en arrière-plan");
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void acquireLocks() {
        try {
            if (wakeLock == null || !wakeLock.isHeld()) {
                PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
                if (manager != null) {
                    wakeLock = manager.newWakeLock(
                            PowerManager.PARTIAL_WAKE_LOCK, "GlobalShare:transfer");
                    wakeLock.acquire();
                }
            }
        } catch (Exception ignored) {
            // Refusé par le constructeur : la notification reste active.
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) return;
            WifiManager wifi = (WifiManager) getApplicationContext()
                    .getSystemService(WIFI_SERVICE);
            if (wifi != null) {
                // LOW_LATENCY (API 29+) garde le Wi-Fi réactif pendant les
                // échanges ; HIGH_PERF en dessous.
                int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifiLock = wifi.createWifiLock(mode, "GlobalShare:transfer");
                wifiLock.acquire();
            }
        } catch (Exception ignored) {
            // Pas de Wi-Fi (données mobiles) : rien à verrouiller.
        }
    }

    private void showNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

        boolean transferring = activeTransfers > 0;
        String text = transferring
                ? (activeTransfers > 1
                        ? activeTransfers + " transferts en cours · " + progress + "%"
                        : "Transfert en cours · " + progress + "%")
                : "Connectée · reste joignable en arrière-plan";
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("GlobalShare")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
                .setCategory(NotificationCompat.CATEGORY_PROGRESS);
        if (transferring) {
            builder.setSmallIcon(android.R.drawable.stat_sys_download);
            builder.setProgress(100, progress, false);
        } else {
            builder.setSmallIcon(android.R.drawable.stat_notify_sync_noanim);
        }
        Notification notification = builder.build();

        // Android 14+ : « dataSync » est plafonné à 6 h par jour ; le type
        // « specialUse » (P2P entre appareils, sans équivalent standard) n'a
        // pas de limite et décrit mieux le service. Les déclarations figurent
        // dans le manifeste (foregroundServiceType + PROPERTY_SPECIAL_USE).
        int foregroundType = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            foregroundType = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE;
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            foregroundType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
        }
        if (foregroundType != 0) {
            startForeground(NOTIFICATION_ID, notification, foregroundType);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    /**
     * Un verrou déjà relâché (ou relâché entre le test et l'appel) lève une
     * RuntimeException : `onDestroy` n'a pas le droit de planter l'app.
     */
    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        } catch (Exception ignored) {
            // Wake lock déjà relâché par le système.
        }
        try {
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        } catch (Exception ignored) {
            // Verrou Wi-Fi déjà relâché par le système.
        }
    }

    @Override
    public void onDestroy() {
        watchdog.removeCallbacks(watchdogTick);
        releaseLocks();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
