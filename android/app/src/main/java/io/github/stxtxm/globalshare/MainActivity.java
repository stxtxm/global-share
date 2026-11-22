package io.github.stxtxm.globalshare;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Le plugin est dans l'application, pas dans un paquet Capacitor : on
        // l'enregistre explicitement avant que le bridge ne soit initialisé.
        registerPlugin(GlobalShareNativePlugin.class);
        super.onCreate(savedInstanceState);

        // Mise à jour « bundle web » appliquée lors d'une session précédente :
        // on sert ce dossier au lieu des ressources embarquées dans l'APK.
        // setServerBasePath recharge lui-même le WebView sur la base configurée.
        if (getBridge() != null) {
            File webDir = UpdateManager.activeWebDir();
            if (webDir != null) getBridge().setServerBasePath(webDir.getAbsolutePath());
        }
    }
}
