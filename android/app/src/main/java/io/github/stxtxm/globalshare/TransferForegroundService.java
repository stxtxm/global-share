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
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/**
 * Garde le transfert WebRTC en vie quand l'écran est verrouillé : notification
 * permanente (foreground service), wake lock CPU et verrou Wi-Fi. Si Android
 * tue quand même le WebView, la reprise IndexedDB reprend au dernier chunk.
 */
public final class TransferForegroundService extends Service {
    public static final String ACTION_START =
            "io.github.stxtxm.globalshare.TRANSFER_START";
    public static final String ACTION_UPDATE =
            "io.github.stxtxm.globalshare.TRANSFER_UPDATE";
    public static final String ACTION_STOP =
            "io.github.stxtxm.globalshare.TRANSFER_STOP";

    private static final String CHANNEL_ID = "globalshare-transfer";
    private static final int NOTIFICATION_ID = 1001;

    private static volatile int activeTransfers;
    private static volatile int progress;

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    public static void start(Context context, int count, int percent) {
        activeTransfers = Math.max(1, count);
        progress = clamp(percent);
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_START);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void update(Context context, int count, int percent) {
        if (count <= 0) {
            stop(context);
            return;
        }
        activeTransfers = count;
        progress = clamp(percent);
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_UPDATE);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void stop(Context context) {
        activeTransfers = 0;
        progress = 0;
        Intent intent = new Intent(context, TransferForegroundService.class);
        intent.setAction(ACTION_STOP);
        context.stopService(intent);
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(100, value));
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        acquireLocks();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (intent != null) {
            int count = intent.getIntExtra("count", activeTransfers);
            int percent = intent.getIntExtra("progress", progress);
            if (count > 0) {
                activeTransfers = count;
                progress = clamp(percent);
            }
        }
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
        channel.setDescription("Maintient le transfert actif quand l'écran est verrouillé");
        channel.setSound(null, null);
        manager.createNotificationChannel(channel);
    }

    private void acquireLocks() {
        try {
            PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
            if (manager != null) {
                wakeLock = manager.newWakeLock(
                        PowerManager.PARTIAL_WAKE_LOCK, "GlobalShare:transfer");
                wakeLock.acquire();
            }
        } catch (Exception ignored) {
            // Refusé par le constructeur : la notification reste active.
        }
        try {
            WifiManager wifi = (WifiManager) getApplicationContext()
                    .getSystemService(WIFI_SERVICE);
            if (wifi != null) {
                wifiLock = wifi.createWifiLock(
                        WifiManager.WIFI_MODE_FULL_HIGH_PERF, "GlobalShare:transfer");
                wifiLock.acquire();
            }
        } catch (Exception ignored) {
            // Pas de Wi-Fi (données mobiles) : rien à verrouiller.
        }
    }

    private void showNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        String text = activeTransfers > 1
                ? activeTransfers + " transferts en cours · " + progress + "%"
                : "Transfert en cours · " + progress + "%";
        Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("GlobalShare")
                .setContentText(text)
                .setOngoing(true)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setProgress(100, progress, false)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
                .setCategory(NotificationCompat.CATEGORY_PROGRESS)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
