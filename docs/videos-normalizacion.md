# Normalización de videos de demostración

El backend necesita `ffmpeg` y `ffprobe` para convertir los videos a MP4/H.264
universal. En Railway, configura en el servicio `api` la variable de entorno
de build:

```text
RAILPACK_DEPLOY_APT_PACKAGES=ffmpeg
```

Railpack instala ese paquete en la imagen final. La aplicación no depende de
esa variable para arrancar: si el binario falta, el comando de normalización
termina con un mensaje explícito y no modifica la base ni R2.

## Orden seguro en Railway

Estos comandos se ejecutan dentro del servicio `api`, nunca contra una URL
pública de la base:

```sh
railway ssh --service api -- node dist/scripts/normalizar-videos.js --inventario
railway ssh --service api -- node dist/scripts/normalizar-videos.js --dry-run
railway ssh --service api -- node dist/scripts/normalizar-videos.js --aplicar
```

`--aplicar` conserva los objetos originales y registra cada reemplazo en
`exercise_video_conversions`. Después de verificar las demostraciones en un
iPhone y Android real, Joel puede revertir una tanda:

```sh
railway ssh --service api -- node dist/scripts/normalizar-videos.js --revertir ultimo
```

Y solo después de esa verificación puede purgar los originales:

```sh
railway ssh --service api -- node dist/scripts/normalizar-videos.js --purgar-originales ultimo
```

Si `railway ssh` no está disponible en el plan o servicio, no se debe usar una
conexión pública de la base como sustituto. La alternativa segura es abrir una
shell del servicio `api` desde el panel de Railway y ejecutar exactamente el
mismo `node dist/scripts/normalizar-videos.js ...`.

La prueba de Safari/iPhone y la de Chrome Android real no se ejecutan en CI;
deben informarse por separado después de la conversión. `jsdom` solo valida la
lógica y no prueba la decodificación de video.

## Salvaguardas verificadas (prueba de punta a punta con base real y R2 simulado)

- Sin argumentos el script hace `--dry-run`: nunca escribe por omisión.
- `--aplicar` repetido no reconvierte ni crea un lote vacío (un lote vacío sería el "último" y estorbaría a `--revertir ultimo`).
- `--revertir` se niega, sin tocar la base, si ya falta algún original en R2 (por ejemplo tras una purga parcial).
- `--purgar-originales` exige indicar el lote (un id, `ultimo` o `todos`); sin argumento se niega.
- Un video que no se puede inspeccionar o convertir queda como estaba y se informa; los demás siguen.
- Duración máxima 90 s (igual que el compresor del navegador) y 180 s de tiempo máximo por orden de `ffmpeg`/`ffprobe`.
- La prueba `backend/test/video-migration-e2e.test.mjs` ejecuta todo el ciclo; se omite si no hay `ffmpeg`.
