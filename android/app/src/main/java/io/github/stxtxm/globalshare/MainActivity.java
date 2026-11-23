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
        // Interface de retour : la fermeture précédente a posé le drapeau
        // « détachée » ; on le lève pour que le salon puisse redemander le
        // service (voir TransferForegroundService.attach).
        TransferForegroundService.attach();

        // Mise à jour « bundle web » appliquée lors d'une session précédente :
        // on sert ce dossier au lieu des ressources embarquées dans l'APK.
        // setServerBasePath recharge lui-même le WebView sur la base configurée.
        if (getBridge() != null) {
            File webDir = UpdateManager.activeWebDir();
            if (webDir != null) getBridge().setServerBasePath(webDir.getAbsolutePath());
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        // Fermeture de l'app (bouton Retour, balayage des récents) : le WebView
        // part avec la tâche, plus aucun transfert ne peut avancer. detach()
        // arrête donc toujours le service et retire la notification ; la
        // reprise se fera depuis IndexedDB à la réouverture. Un simple passage
        // en arrière-plan ou une rotation ne termine pas l'activité, le
        // service reste donc intact.
        if (isFinishing()) TransferForegroundService.detach(this);
    }
}
