# Visor Global de Soya — ALEN+PRO

Visor de mercado del frijol soya (EE.UU., Argentina, Brasil) para compartir entre el
equipo desde cualquier dispositivo. La información se recolecta **automáticamente 2 veces
al día** y se guarda en Firebase; el visor solo la lee, así que vive en GitHub Pages sin
exponer ninguna clave.

## Cómo funciona (3 piezas)

```
  GitHub Actions  ──(2 veces/día)──►  recolector.js  ──escribe──►  Firebase
   (programador)                      (consulta API)              /mercado-soya/latest
                                                                        │ lee
                                                                        ▼
                                                                  index.html
                                                                (GitHub Pages)
```

1. **recolector.js** — consulta el API de Anthropic (con búsqueda web) y escribe el snapshot
   en Firebase con el Admin SDK (cuenta de servicio).
2. **.github/workflows/recolector.yml** — corre el recolector 2 veces al día (09:00 y 14:30
   hora Colombia) y permite ejecutarlo a mano desde *Actions*.
3. **index.html** — el visor. Lee `/mercado-soya/latest`. Se publica en GitHub Pages.

## Instalación (una sola vez)

### 1. Crear el proyecto Firebase
console.firebase.google.com → Agregar proyecto (ej. `visor-soya-alenpro`).
Build → Realtime Database → Crear base de datos → modo bloqueado.

### 2. Reglas de seguridad
En Realtime Database → pestaña Reglas, pega y publica:

```json
{
  "rules": {
    "mercado-soya": {
      "latest":    { ".read": true, ".write": false },
      "historico": { ".read": true, ".write": false }
    },
    "$other": { ".read": false, ".write": false }
  }
}
```

> El recolector usa el Admin SDK (cuenta de servicio), que **omite las reglas**: por eso
> aquí la escritura puede quedar en `false` para todos los clientes. El recolector igual escribe.

### 3. Generar la cuenta de servicio (en vez del database secret legacy)
Engranaje ⚙ (al lado de "Descripción general del proyecto", arriba a la izquierda) →
**Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada**.
Se descarga un archivo `.json`. Guarda su contenido completo.

### 4. Secrets del repositorio
GitHub → Settings → Secrets and variables → Actions → New repository secret:

| Secret                     | Valor                                                      |
|----------------------------|------------------------------------------------------------|
| `ANTHROPIC_API_KEY`        | Clave del API de Anthropic (console.anthropic.com)         |
| `FIREBASE_DB_URL`          | `https://TU-PROYECTO-default-rtdb.firebaseio.com`          |
| `FIREBASE_SERVICE_ACCOUNT` | El **contenido completo** del archivo JSON de la cuenta    |

### 5. Apuntar el visor a tu Firebase
En `index.html`, edita:
```js
const FIREBASE_DB_URL = "https://TU-PROYECTO-default-rtdb.firebaseio.com";
```

### 6. Publicar en GitHub Pages
Settings → Pages → Source: rama main → carpeta /root. La URL queda lista para compartir.

### 7. Primera ejecución
Actions → Recolector mercado soya → Run workflow. Luego corre solo 2 veces al día.

## Horarios
- `14:00 UTC` = 09:00 Colombia → apertura de CBOT
- `19:30 UTC` = 14:30 Colombia → cierre de CBOT

Para cambiarlos, edita las líneas `cron` en `.github/workflows/recolector.yml`.

## Notas
- El visor relee Firebase cada 15 min mientras la pestaña esté abierta (no consume API).
- El histórico queda en `/mercado-soya/historico/` para gráficas futuras.
- "Torta de soya (SBM)" se usa en todo texto en español; nunca "harina de soya".
