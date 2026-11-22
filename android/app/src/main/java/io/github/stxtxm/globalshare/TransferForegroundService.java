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
 *   la socket tombe et les pairs nous voient partir). Republicain : l'app est
 *   revenue au premier plan ou a quitté le salon → l'UI envoie keepAlive=false.
 * - Les transferts : compteur affiché dans la notification (envoi et réception
 *   passent par le même compteur web).
 *
 * Le service ne s'arrête que quand les deux sont à zéro. Si Android tue quand
 * même le WebView, la reprise IndexedDB repart au dernier chunk.
 */
public final class TransferForegroundService extends Service {
    public static final String ACTION_START =
            "io.github.stxtxm.globalshare.TRANSFER_START";
    public static final String ACTION_UPDATE =
            "io.github.stxtxm.globalshare.TRANSFER_UPDATE";
    public static final String ACTION_KEEP_ALIVE =
            "io.github.stxtxm.globalshare.TRANSFER_KEEP_ALIVE";
    public static final String ACTION_STOP =
            "io.github.stxtxm.globalshare.TRANSFER_STOP";

    private static final String CHANNEL_ID = "globalshare-transfer";
    private static final int NOTIFICATION_ID = 1001;

    private static volatile int activeTransfers;
    private static volatile int progress;
    private static volatile boolean keepAlive;

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

    /** Session salon connectée : la connexion doit survivre à l'arrière-plan. */
    public static void setKeepAlive(Context context, boolean enabled) {
        keepAlive = enabled;
        if (enabled) {
            Intent intent = new Intent(context, TransferForegroundService.class);
            intent.setAction(ACTION_KEEP_ALIVE);
            ContextCompat.startForegroundService(context, intent);
        } else if (activeTransfers == 0) {
            context.stopService(new Intent(context, TransferForegroundService.class));
        }
    }

    public static void start(Context context, int count, int percent) {
        activeTransfers = Math.max(1, count);
        progress = clamp(percent);
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_START);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void update(Context context, int count, int percent) {
        if (count <= 0) {
            finishTransfers(context);
            return;
        }
        activeTransfers = count;
        progress = clamp(percent);
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_UPDATE);
        ContextCompat.startForegroundService(context, intent);
    }

    /** Transferts terminés : le service ne reste que si la session le demande. */
    private static void finishTransfers(Context context) {
        activeTransfers = 0;
        progress = 0;
        if (!keepAlive) {
            context.stopService(new Intent(context, TransferForegroundService.class));
            return;
        }
        // Session toujours ouverte : on ne garde que la connexion.
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_KEEP_ALIVE);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void stop(Context context) {
        activeTransfers = 0;
        progress = 0;
        keepAlive = false;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_STOP);
        context.stopService(intent);
    }

    public static boolean isRunning() {
        return keepAlive || activeTransfers > 0;
    }

    public static boolean isBatteryOptimized(android.content.Context context) {
        PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return power != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && !power.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(100, value));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        acquireLocks();
        // Tick natif : les timers du WebView sont bridés à 1/min après 5 min
        // masqués (Chrome 88+), même avec un PARTIAL_WAKE_LOCK. Ce tick, lui,
        // tourne tant que le service est vivant et pilote la reprise côté JS.
        watchdog.postDelayed(watchdogTick, 10_000);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null && !ACTION_KEEP_ALIVE.equals(action)) {
            int count = intent.getIntExtra("count", activeTransfers);
            int percent = intent.getIntExtra("progress", progress);
            if (count > 0) {
                activeTransfers = count;
                progress = clamp(percent);
            }
        }
        acquireLocks();
        showNotification();
        // START_STICKY : si le système relance le service, la notification et
        // le wake lock sont rétablis avec le dernier état connu.
        return START_STICKY;
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

    @Override
    public void onDestroy() {
        watchdog.removeCallbacks(watchdogTick);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
