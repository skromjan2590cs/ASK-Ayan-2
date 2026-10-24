# 🤖 ASK-Ayan Ultra Bot

A custom Facebook Messenger and multi-platform automation bot deployed on Render with 24/7 keep-alive web service integration.

---

## 🚀 Live Status
- **Web Service URL:** [https://ask-ayan-2-10.onrender.com](https://ask-ayan-2-10.onrender.com)
- **Deployment Platform:** Render (Free Tier + Express Keep-Alive)
- **Node.js Version:** v26.12.1

---

## ✨ Features
- **Session-Based Authentication:** Works seamlessly using `account.txt` (Appstate/Cookies).
- **Express HTTP Keep-Alive:** Prevents Render instances from going idle/shutting down on `console` adapter EOF events.
- **Admin Command Protection:** Secured via `adminUids` configuration in `config.json`.
- **Multi-Platform Ready:** Designed for future expansion to WhatsApp, Instagram, and TikTok.

---

## 🛠️ Project Structure
```text
├── core/             # Core bot logic and adapter handlers
├── scripts/cmds/     # Bot command scripts
├── account.txt       # Session/Cookie data for authentication
├── config.json       # Central bot and transport configurations
├── index.js          # Entry point with process exit override & Express HTTP server
└── package.json      # Dependencies and execution scripts
