package io.github.stxtxm.globalshare;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Le plugin est dans l'application, pas dans un paquet Capacitor : on
        // l'enregistre explicitement avant que le bridge ne soit initialisé.
        registerPlugin(GlobalShareNativePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
