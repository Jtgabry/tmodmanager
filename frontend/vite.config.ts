import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// In sviluppo le chiamate /api e /sanctum vengono inoltrate a Laravel (php artisan serve).
// In produzione Apache serve la build di React e passa /api a Laravel sullo stesso dominio.
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

/** Colore di sfondo dell'app (--bg in src/index.css): barra di stato e schermata di avvio. */
const APP_BACKGROUND = '#17120d'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Il service worker nuovo resta in attesa finché l'utente non sceglie "Aggiorna" (vedi UpdatePrompt).
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'favicon-96x96.png', 'apple-touch-icon.png'],
      manifest: {
        id: '/',
        name: 'tModManager',
        short_name: 'tModManager',
        description: 'Pannello per gestire i server Terraria / tModLoader',
        lang: 'it',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: APP_BACKGROUND,
        background_color: APP_BACKGROUND,
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/maskable-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: '/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Solo la "shell" dell'app finisce in cache: dati, login e console arrivano sempre dal server.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/(api|sanctum|up|ws)(\/|$)/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: {
    proxy: {
      '/api': backend,
      '/sanctum': backend,
    },
  },
})
