# Transferts de fichiers — débit, fiabilité, protocole

GlobalShare envoie les fichiers par **canal direct WebRTC** (même réseau) et
retombe sur le **relais Socket.IO / Cloudflare Worker** dès que le direct n'est
pas possible (réseaux différents, NAT symétrique). Les deux chemins partagent
le même gestionnaire `app/components/TransferManager.ts` : ACK par chunk,
déduplication, reprise octet par octet et contrôle SHA-256.

## Réglages par défaut (v1.0.29)

| Paramètre | Valeur | Pourquoi |
| --- | --- | --- |
| Taille d'un chunk (relais) | **512 Ko** | 4× moins de messages dans le Durable Object et 4× moins d'ACK qu'à 128 Ko. Le destinataire s'aligne sur la taille réelle du premier chunk reçu, donc un ancien client peut recevoir les nouveaux chunks. |
| Taille d'un chunk (LAN P2P) | 256 Ko | Le canal SCTP a une faible latence : pas besoin de blocs plus gros. |
| Chunks en vol | 24 (relais), 32 (LAN) | 12 Mo de données en vol sur le relais : le tuyau reste plein même avec un RTT de plusieurs centaines de ms. |
| Timeout d'ACK | `max(3 s, 5 × RTT mesuré)`, plafonné à 20 s | L'ancien délai fixe de 15 s immobilisait un créneau pendant un quart de minute sur un ACK perdu. |
| Budget de retransmissions | 3 **par chunk** | Un budget global annulait tout le fichier après 4 incidents éparpillés. |

## Ce qui a été corrigé pour le débit

1. **Relais : course condition sur les pièces jointes binaires.** Le Durable
   Object gardait un seul `pendingBinary`. Le client pipeligne 24 chunks, donc
   le header du chunk suivant écrasait le header courant avant que son
   attachment arrive : des chunks étaient perdus puis retransmis après 15 s.
   Les headers sont maintenant stockés dans une file FIFO
   (`socket-server-cloudflare/src/index.ts`) et le test de protocole envoie
   24 × 128 Ko d'affilée pour verrouiller le comportement.

2. **Compression WebSocket désactivée** (`compression: false` dans `io()`).
   Les fichiers (déjà compressés ou chiffrés) ne sont pas compressibles :
   `permessage-deflate` ne faisait que consommer du CPU sur le téléphone et
   retarder les ACK.

3. **Vitesse réellement calculée dans les deux sens.** Auparavant :
   - le destinataire ne calculait **jamais** `t.speed` → « 0 B/s » permanent ;
   - l'expéditeur utilisait une fenêtre cumulative jamais réinitialisée et la
     formule `max(speed × 0,6, avg × 0,4)` convergeait vers **40 % du débit
     réel** ;
   - aucune horloge ne remettait la vitesse à zéro quand le réseau se tait.
   
   Un compteur de débit sur fenêtre glissante d'1 s, partagé par les deux
   directions, publie maintenant un débit lissé, remis à zéro après 2 s sans
   octet. L'interface n'affiche plus le double suffixe « /s/s ».

4. **Boucle d'envoi relancée par les ACK.** Un ACK libère un créneau ; la boucle
   est réveillée tout de suite au lieu d'attendre son timer de 2 ms (bridé à
   ~1 s dans une WebView en arrière-plan). Elle redémarre aussi après un
   `transfer-resync`, ce qui évitait un blocage définitif à l'ancien pourcentage.

5. **Suivi de progression linéaire.** Le destinataire maintenait une somme
   `O(n)` sur tous les chunks à chaque réception ; il utilise maintenant un
   compteur incrémental (1 Go = ~2000 chunks avec les blocs de 512 Ko).

6. **Réglage « Tentatives » conservé** dans une ref et réappliqué à chaque
   recréation du gestionnaire (reconnexion, changement de salon).

## Protocole (pour les clients anciens)

- `transfer-init` annonce la taille des chunks ; le récepteur ignore l'annonce
  dès le premier bloc réel (compatibilité avec les APK 1.0.17 qui envoyaient
  des blocs LAN plus gros que la valeur annoncée).
- `transfer-chunk` transporte les octets en pièce jointe binaire ; le format
  texte historique (`Array.from`) reste accepté.
- `transfer-ack` est envoyé pour chaque chunk, y compris les doublons.
- `transfer-eof` est réémis jusqu'à `transfer-eof-ack`. Si le récepteur n'a pas
  tout reçu, il répond `transfer-resync` avec `haveBytes` et l'expéditeur
  reprend exactement à cette frontière.
- Les chunks reçus sont persistés dans IndexedDB pour survivre à un onglet tué.

## Vérifier localement

```bash
# Relais
cd socket-server-cloudflare && npx wrangler dev --port 8787
npm run test:protocol          # inclut le burst binaire 24 × 128 Ko

# Client
npm run test:unit              # 53 tests, dont 5 sur débit et retransmissions
npm run build
```

Le Worker est redéployé automatiquement par `.github/workflows/deploy.yml` à
chaque push sur `main` ; le `nativeVersion` reste à `2` (aucun changement de
coquille native), donc les applications installées récupèrent ces corrections
par le bundle web (~1,4 Mo) sans retélécharger l'APK complet.
