# 🎨 Chell Dashboard

Dashboard web complet pour gérer et configurer le bot Discord **Chell** avec une interface moderne et intuitive.

## ✨ Fonctionnalités

### 🔐 Authentification
- Connexion via Discord OAuth2
- Gestion de session sécurisée
- Accès limité aux serveurs où l'utilisateur est administrateur

### 🤖 Intelligence Artificielle
- Activation/désactivation globale
- **10 personnalités** disponibles : Gentille, Caractérielle, Rick, Reddington, Fresita, Chill, Productivité, Blala, Miroir, Lucifer
- Blocage par salon avec interface intuitive (clic pour bloquer/débloquer)
- Actions groupées : "Bloquer tout" / "Débloquer tout"

### 🛡️ Modération
- Gestion des warns (max warns, actions automatiques, DM)
- Historique des avertissements
- Configuration des sanctions (ban, kick, timeout, mute)

### 📥 Message d'accueil
- Configuration du salon de bienvenue
- Message personnalisable avec variables `{user}`, `{server}`, `{memberCount}`
- Image de bienvenue optionnelle

### 🛡️ AutoMod
- Filtrage de toxicité avec IA (FastText ML)
- Détection de spam, majuscules, liens, emojis, mentions
- Configuration des seuils et actions

### 🚨 Anti-Raid
- Détection automatique des raids
- Configuration du seuil de détection et fenêtre temporelle
- Actions : kick, ban, verrouillage, alerte uniquement
- Vérification de l'âge des comptes
- Blocage des invitations Discord

### 🏆 Système XP & Niveaux
- Leaderboard interactif (top 10 membres)
- Configuration de l'XP par message et cooldown
- Messages de niveau personnalisables
- Barre de progression pour chaque membre

### 📋 Logs
- **5 catégories** : Modération, Membres, Messages, Vocal, Serveur
- Configuration des salons de logs pour chaque catégorie
- Activation/désactivation indépendante

### 🎫 Tickets
- Système de tickets avec transcriptions HTML
- Configuration : salon de création, catégorie, rôles support
- Auto-fermeture configurable
- Notifications DM optionnelles
- Message de bienvenue personnalisable

### 🏷️ Auto-Rôles
- Attribution automatique de rôles à l'arrivée
- Gestion des rôles par réaction (reaction roles)
- Option pour ignorer les bots

### 📡 Réseaux Sociaux & RSS
- Support : RSS, Twitter/X, YouTube, Twitch
- Gestion des flux avec état actif/pausé
- Configuration de l'intervalle de vérification
- Format des messages (embed/texte)
- Notifications @everyone optionnelles

## 🚀 Installation

### Prérequis
- **Node.js** 18+ (recommandé : 20+)
- **pnpm** (ou npm/yarn)
- Accès aux bases de données PostgreSQL et MySQL du bot Chell

### Étapes

1. **Naviguer dans le dossier**
   ```bash
   cd "C:\Users\mdalla\Desktop\CHELL\CHELL BOT\dashboard"
   ```

2. **Installer les dépendances**
   ```bash
   pnpm install
   ```

3. **Configurer les variables d'environnement**
   
   Le fichier `.env` est déjà présent avec les bonnes valeurs :
   - `BOT_TOKEN` : Token du bot Discord
   - `CLIENT_ID` / `CLIENT_SECRET` : OAuth2 credentials
   - `SESSION_SECRET` : Clé secrète pour les sessions (générer une nouvelle en production)
   - `PORT` : Port d'écoute (défaut: 80, changer en 5000 pour éviter besoin admin)
   - `CALLBACK_URL` : https://dash.chell.fr/callback
   - PostgreSQL et MySQL : configurations de connexion
   - `OWNER_IDS` : IDs des propriétaires du bot

4. **Démarrer le dashboard**
   
   **Développement** (port 5000):
   ```bash
   # Modifier PORT=5000 dans .env
   pnpm start
   # Ou: node server.js
   ```
   
   **Production** (port 80, nécessite admin/root):
   ```powershell
   # Windows (PowerShell en tant qu'admin)
   node server.js
   ```

5. **Accéder au dashboard**
   - Développement : http://localhost:5000
   - Production : http://dash.chell.fr (après configuration DNS)

## 🌐 Déploiement Production (Linux)

### 1. Copier le dashboard sur le serveur
```bash
scp -r dashboard/ user@server:/opt/chell-dashboard/
```

### 2. Installer les dépendances
```bash
cd /opt/chell-dashboard
pnpm install --production
```

### 3. Configurer systemd (service automatique)

Créer `/etc/systemd/system/chell-dashboard.service` :
```ini
[Unit]
Description=Chell Discord Bot Dashboard
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/chell-dashboard
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Activer et démarrer :
```bash
sudo systemctl enable chell-dashboard
sudo systemctl start chell-dashboard
sudo systemctl status chell-dashboard
```

### 4. Configurer nginx (reverse proxy)

Créer `/etc/nginx/sites-available/dash.chell.fr` :
```nginx
server {
    listen 80;
    server_name dash.chell.fr;

    location / {
        proxy_pass http://localhost:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Activer :
```bash
sudo ln -s /etc/nginx/sites-available/dash.chell.fr /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Configurer SSL avec Let's Encrypt
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d dash.chell.fr
```

### 6. Configurer le pare-feu
```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 🔧 Configuration Discord App

1. Aller sur **Discord Developer Portal** : https://discord.com/developers/applications

2. Sélectionner l'application **Chell** (ID: 1383154920231796736)

3. **OAuth2 → Redirects** : Ajouter l'URL de callback
   ```
   https://dash.chell.fr/callback
   ```

4. **OAuth2 → Scopes** (déjà configurés) :
   - `identify` : Récupérer les infos utilisateur
   - `guilds` : Liste des serveurs
   - `guilds.members.read` : Infos des membres

5. Sauvegarder les modifications

## 📁 Structure du Projet

```
dashboard/
├── server.js                    # Point d'entrée, Express server
├── package.json                 # Dépendances et scripts
├── .env                         # Variables d'environnement
├── config/
│   ├── passport.js             # Stratégie Discord OAuth2
│   └── database.js             # Connexions PostgreSQL + MySQL
├── routes/
│   ├── auth.js                 # Routes d'authentification
│   ├── api.js                  # API REST (guilds, config)
│   ├── guild.js                # Pages de configuration des serveurs
│   └── dashboard.js            # Dashboard principal
├── views/
│   ├── layout.ejs              # Template principal
│   ├── landing.ejs             # Page d'accueil
│   ├── dashboard.ejs           # Sélection de serveur
│   ├── partials/
│   │   ├── navbar.ejs          # Barre de navigation
│   │   └── sidebar.ejs         # Menu latéral serveur
│   └── guild/
│       ├── overview.ejs        # Vue d'ensemble serveur
│       ├── ai.ejs              # Configuration IA
│       ├── moderation.ejs      # Modération & warns
│       ├── welcome.ejs         # Message d'accueil
│       ├── automod.ejs         # AutoMod IA
│       ├── antiraid.ejs        # Anti-Raid
│       ├── xp.ejs              # Système XP & niveaux
│       ├── logs.ejs            # Configuration logs
│       ├── tickets.ejs         # Système tickets
│       ├── autoroles.ejs       # Rôles automatiques
│       └── social.ejs          # Flux RSS & réseaux
├── public/
│   ├── css/
│   │   └── main.css            # Styles (Chell.fr design)
│   ├── js/
│   │   └── main.js             # JavaScript client
│   └── img/
│       └── chell-logo.png      # Logo Chell
└── README.md                    # Ce fichier
```

## 🎨 Design

Le dashboard utilise le système de design de **chell.fr** :
- **Couleurs** : Violet profond (#7c3aed), Noir (#0a0a0f), Or (#f59e0b)
- **Police** : Inter (Google Fonts)
- **Icônes** : Font Awesome 6.5
- **Thème** : Dark mode sombre avec accents lumineux
- **Animations** : Transitions fluides, effets hover élégants

## 📊 API Endpoints

### Authentification
- `GET /auth/login` — Redirige vers Discord OAuth2
- `GET /auth/callback` — Callback OAuth2
- `GET /auth/logout` — Déconnexion

### Guilds
- `GET /api/guilds` — Liste des serveurs gérés par l'utilisateur
- `GET /api/guild/:id` — Infos et configuration d'un serveur
- `GET /api/guild/:id/channels` — Liste des salons
- `GET /api/guild/:id/roles` — Liste des rôles
- `GET /api/stats` — Statistiques globales (owners uniquement)

### Configuration
- `GET/POST /api/guild/:id/ai` — Config IA (enabled, personality, blockedChannels)
- `GET/POST /api/guild/:id/welcome` — Config message d'accueil
- `GET/POST /api/guild/:id/automod` — Config AutoMod
- `GET/POST /api/guild/:id/antiraid` — Config Anti-Raid
- `GET/POST /api/guild/:id/logs` — Config logs
- `GET/POST /api/guild/:id/tickets` — Config tickets
- `GET/POST /api/guild/:id/autoroles` — Config auto-rôles
- `POST /api/guild/:id/social/feed` — Ajouter un flux RSS
- `GET /api/guild/:id/xp` — Leaderboard XP
- `GET /api/guild/:id/warns` — Historique warns

## 🔒 Sécurité

- Sessions avec `express-session` et secret fort
- Helmet.js pour headers HTTP sécurisés
- CORS configuré pour `chell.fr` et `dash.chell.fr`
- Middleware `ensureAuth` pour protéger les routes
- Vérification des permissions Discord (administrateur requis)
- Variables sensibles dans `.env` (non commité)

## 🐛 Dépannage

### Port 80 déjà utilisé
```bash
# Windows - Vérifier les processus sur le port 80
Get-Process -Id (Get-NetTCPConnection -LocalPort 80).OwningProcess | Select-Object -Property ProcessName, Id

# Linux
sudo lsof -i :80

# Solution : Utiliser un autre port (5000, 3000)
# Modifier PORT=5000 dans .env
```

### Erreurs de connexion à la base de données
- Vérifier les credentials PostgreSQL/MySQL dans `.env`
- Tester la connexion : `node -e "require('./config/database')"`
- Vérifier les pare-feu et accès réseau

### Discord OAuth2 ne fonctionne pas
- Vérifier que le `CALLBACK_URL` dans `.env` correspond à celui configuré sur Discord
- S'assurer que `CLIENT_ID` et `CLIENT_SECRET` sont corrects
- Vérifier que les redirects sont bien configurés sur Discord Developer Portal

### Styles cassés / Images manquantes
- Vérifier que `/public/css/main.css` existe
- Créer un logo dans `/public/img/chell-logo.png`
- Vider le cache navigateur (Ctrl+F5)

## 📝 TODO / Améliorations Futures

- [ ] Ajouter gestion des commandes personnalisées
- [ ] Interface pour gérer les confessions
- [ ] Statistiques avancées (graphiques avec Chart.js)
- [ ] Système de notifications temps réel (WebSocket)
- [ ] Thème clair optionnel
- [ ] Support multilingue (FR/EN)
- [ ] Logs d'audit pour les modifications dashboard
- [ ] Export des configurations (backup JSON)

## 🤝 Contribution

Pour contribuer au développement du dashboard :

1. Fork le projet
2. Créer une branche (`git checkout -b feature/NouvelleFonctionnalité`)
3. Commit les changements (`git commit -m 'Ajout NouvelleFonctionnalité'`)
4. Push vers la branche (`git push origin feature/NouvelleFonctionnalité`)
5. Ouvrir une Pull Request

## 📄 Licence

Ce dashboard est propriétaire et fait partie du projet **Chell Discord Bot**.
© 2026 Chell Team. Tous droits réservés.

## 📧 Support

Discord : [Serveur Chell](https://discord.gg/chell)
Site web : https://chell.fr
Dashboard : https://dash.chell.fr

---

**Développé avec ❤️ par l'équipe Chell**
