# Contribuir a OpenBridge

Gracias por querer aportar. OpenBridge es una app + puente + tunel en Node para
manejar `opencode` desde el celular, sin hosting.

## Requisitos

- Node **18 o superior** (probado en 18/20/22).
- `opencode` instalado en el PATH (solo para probar el puente de verdad).
- No hace falta nada mas: el runtime usa APIs nativas de Node y `web-push` es la
  unica dependencia de produccion.

## Puesta en marcha

```bash
npm install
npm test        # node --test (Windows/Linux/macOS)
npm run lint    # node --check sobre todo el JS
```

Para correr la app en local:

```bash
node bin/openbridge.js init --yes --dir <casa>
node bin/openbridge.js server --no-tunnel --stream
node bin/openbridge.js stop --dir <casa>
```

## Convenciones

- **CommonJS**, `'use strict'` al inicio, 4 espacios, comillas simples.
- Comentarios y textos de usuario **en espanol, sin tildes** (compatibilidad de
  consola).
- No agregar dependencias salvo que sea imprescindible.
- La API mantiene el contrato de la version PHP (`?action=...`); no lo rompas:
  lo usan `src/web/assets/app.js` y `src/bridge/bridge.js`.
- Toda escritura de datos pasa por `src/store` (mutex + escritura atomica).
- No commitear `.openbridge/` ni los archivos legacy (`config.json`, `app.json`,
  `data/`, `logs/`); estan en `.gitignore`.

## Antes de abrir un PR

1. `npm test` y `npm run lint` en verde.
2. Si agregas una funcion, sumala a los tests (`test/`).
3. Actualiza `TODO.md` y `CHANGELOG.md` (seccion `[Unreleased]`) si corresponde.
4. Describe el cambio y como probarlo.

El mapa de archivos y las decisiones de arquitectura estan en
`docs/ARCHITECTURE.md`.

## Release (solo el dueno)

El proceso es privado (`scripts/release.mjs`) y exige credenciales del dueno
(`npm whoami` = `danieltmn`, remoto `tamnora/openbridge`). No lo corras si no
sos el dueno: aborta solo. Detalles en `AGENTS.md`.
