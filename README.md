# Mayadrop (Tailwind + TURN) — Fixed Build

## Quick Start (dev)
```bash
npm install
npm run dev
# open http://localhost:5175 (WS server should run separately at :3000 if your server.js starts it),
# or run `npm start` after build to serve from :3000
```

## Production
```bash
npm run build
npm start
# open http://<LAN-IP>:3000
```

## Docker Compose (App + coturn)
```bash
export TURN_SECRET=$(openssl rand -hex 16)
export HOST_IP=$(hostname -I | awk '{print $1}')
docker compose up --build
```

## Tailwind Build Fixes
- Configs renamed to CommonJS: `tailwind.config.cjs`, `postcss.config.cjs`
- Added `src/style.css` with Tailwind directives
- Injected `import './style.css'` at the top of `src/main.js`
- Removed `<link href="/dist/output.css">` from index.html — Vite injects CSS automatically
