package io.github.stxtxm.globalshare;

import com.getcapacitor.JSObject;
import java.util.Iterator;

/**
 * État de mise à jour partagé entre le plugin Capacitor et le gestionnaire
 * réseau. Toutes les valeurs sont normalisées : l'interface ne doit jamais
 * recevoir de progression nulle ou NaN.
 */
final class UpdaterState {
    private static final JSObject STATE = new JSObject();

    private UpdaterState() {}

    static {
        try {
            STATE.put("status", "idle");
            STATE.put("currentVersion", "");
            STATE.put("version", "");
            STATE.put("percent", 0);
            STATE.put("transferred", 0);
            STATE.put("total", 0);
            STATE.put("bytesPerSecond", 0);
            STATE.put("requiresAdmin", false);
            STATE.put("message", "");
        } catch (Exception ignored) {
            // JSObject extends JSONObject : ces puts ne peuvent pas échouer.
        }
    }

    interface Listener {
        void onState(JSObject state);

        void onOpen();
    }

    private static Listener listener;

    static synchronized void setListener(Listener value) {
        listener = value;
    }

    static synchronized void patch(JSONObjectPatch patch) {
        try {
            Iterator<String> keys = patch.values.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                STATE.put(key, patch.values.get(key));
            }
        } catch (Exception ignored) {
            return;
        }
        Listener current = listener;
        if (current != null) current.onState(snapshot());
    }

    static synchronized void open() {
        Listener current = listener;
        if (current != null) current.onOpen();
    }

    static synchronized JSObject snapshot() {
        JSObject copy = new JSObject();
        try {
            Iterator<String> keys = STATE.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                copy.put(key, STATE.get(key));
            }
        } catch (Exception ignored) {
            // State toujours valide : on renvoie la copie construite.
        }
        return copy;
    }

    /** Petit helper pour éviter de propager JSONException dans tout le code. */
    static final class JSONObjectPatch {
        final JSObject values = new JSObject();

        JSONObjectPatch put(String key, Object value) {
            try {
                values.put(key, value);
            } catch (Exception ignored) {
                // Valeur toujours sérialisable ici.
            }
            return this;
        }
    }
}
