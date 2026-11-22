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
| Timeout d'ACK | `max(8 s, 6 × RTT mesuré)`, plafonné à 30 s | Un plancher à 3 s provoquait des retransmissions prématurées et un livelock avec 12 Mo en vol. |
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

## Correction du blocage à ~50 % (v1.0.30)

Un fichier de 60 Mo (~120 chunks) pouvait se figer vers la moitié alors que le
débit affiché restait non nul. C'était un **livelock de retransmissions**, pas
une perte de connexion :

1. Le timeout plancher avait été réduit à 3 s alors que 24 × 512 Ko = 12 Mo
   sont en vol. Sur un relais chargé, les ACK mettent plus de 3 s à revenir.
2. Les 24 minuteurs, armés dans la même rafale, expiraient presque ensemble →
   24 réémissions → file d'attente doublée → nouveaux ACK encore plus lents.
3. Chaque ACK tardif **remettait le budget de tentatives à zéro**, donc le
   transfert ne progressait plus mais ne s'annulait jamais.

Correctifs appliqués :

- timeout relais plancher **8 s** (12 s sans RTT mesuré), le RTT ne pouvant
  qu'augmenter la marge, avec étalement déterministe des minuteurs
  (`seq % 8 × 250 ms`) pour éviter l'expiration simultanée ;
- **budget de tentatives jamais remis à zéro** sur un ACK — un chunk acquitté
  n'est plus retransmis de toute façon (son minuteur est supprimé) ;
- fenêtre d'envoi **adaptative** : ~6 Mo en vol, réduite à ~3 Mo si le RTT
  augmente, au lieu de 12 Mo fixes ;
- progression affichée = **préfixe contigu** (un trou devient visible au lieu
  d'un faux 100 %) et sortie explicite de la boucle EOF ↔ resync après 3
  tentatives à la même position, avec un message d'erreur clair ;
- `rttMs` réinitialisé sur reprise, Durable Object : file de headers portée à
  256 et `ws.send()` en échec ne ferme plus la socket (le watchdog ping s'en
  charge) — fermer perdait tous les chunks en vol ;
- test de protocole porté à **24 × 512 Ko = 12 Mo** (la vraie configuration)
  et test unitaire « aucun ACK lent ne doit provoquer de retransmission
  prématurée à 9 s ».

## Bouton « Annuler » (v1.0.31)

Le bouton est désormais un arrêt complet, identique au nettoyage qui se
produisait quand on quittait le salon — c'est précisément pour cela que quitter
le salon « fonctionnait » alors que le bouton ne faisait rien.

`TransferManager.cancel()` et `onTransferCancel()` appellent un helper `_stop()`
qui :

- coupe les `ackTimers` **et** l'`eofTimer` (l'ancienne closure `emitEof` se
  reprogrammait toutes les 2 s sans jamais vérifier le statut) ;
- vide `pending`, `buffer`, `ackAttempts`, `sentAt` et le `chunkStore` côté
  réception (les chunks partiels n'étaient effacés que du côté expéditeur) ;
- **retire le transfert du `Map` interne** : sinon `getAll()` le réinjectait
  dans l'interface 200 ms plus tard, donnant l'impression que le clic n'avait
  rien fait ;
- empêche tout handler socket (`transfer-chunk`, `transfer-ack`, `transfer-eof`,
  `transfer-resync`, `transfer-end`) de faire revivre un transfert terminal ou
  d'enregistrer le fichier après annulation.

Côté interface, `syncTransfers()` filtre aussi les statuts terminaux, le timer
de rafraîchissement en attente est annulé sur clic, et les lignes orphelines
(manager recréé après reconnexion) sont retirées. Un bouton « Annuler » a été
ajouté dans la mini-barre, seule surface toujours visible sur mobile.

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
