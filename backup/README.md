# Respaldo automático de la base de datos

`pg_dump` del Postgres del proyecto → Cloudflare R2, con rotación.
Corre en Railway como **Cron Job**: se enciende, sube el dump y se apaga.

Existe porque el Postgres de Railway vive en un volumen del propio proyecto:
si el servicio se reinicia mal o alguien lo recrea, no hay una segunda copia en
ningún otro sitio. R2 es otro proveedor, así que un problema en Railway no se
lleva por delante los respaldos.

## Horario

`0 7 * * *` — todos los días a las 07:00 UTC, que en Panamá son las 02:00.
Se elige esa hora porque no hay nadie entrenando ni cobrando de madrugada.

## Dónde quedan

`eileen-lifestyle-private/db-backups/eileen-lifestyle/AAAA-MM-DD_HHMM.dump`

Retención de 30 días; los más viejos se borran solos en cada corrida.

## Restaurar

```
pg_restore --no-owner --no-acl -d "$DATABASE_URL" 2026-08-30_0700.dump
```

Un respaldo que nunca se restauró no es un respaldo, es una suposición:
conviene probar la restauración contra una base vacía de vez en cuando.
