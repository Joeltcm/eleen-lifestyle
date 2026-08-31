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

El `cronSchedule` de este railway.json **no se aplica**: Railway sólo lee la
configuración como código desde la raíz del repositorio, y esa raíz ya la ocupa
el railway.json del API. El horario está puesto directamente en el servicio, y
se consulta o se cambia por la API de Railway sin salir de la terminal:

```
# ver el horario de todos los servicios
railway api 'query { environment(id: "<ENV_ID>") { serviceInstances { edges { node { serviceName cronSchedule } } } } }'

# cambiarlo
railway api 'mutation F($s: String!, $e: String, $i: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $s, environmentId: $e, input: $i) }' \
  --var s=<SERVICE_ID> --var e=<ENV_ID> --variables '{"input":{"cronSchedule":"0 7 * * *"}}'
```

`railway api` usa la sesión de la propia CLI, así que no hace falta un token
aparte. La política de reinicio debe ser `NEVER` y no debe haber healthcheck:
es un trabajo que corre, termina y se apaga, no un servicio que se queda vivo.

## Dónde quedan

`eileen-lifestyle-private/db-backups/eileen-lifestyle/AAAA-MM-DD_HHMM.dump`

Retención de 30 días; los más viejos se borran solos en cada corrida.

## Restaurar

```
pg_restore --no-owner --no-acl -d "$DATABASE_URL" 2026-08-30_0700.dump
```

**Hace falta pg_restore 18 o superior.** El dump sale de un Postgres 18 y usa
la versión de formato 1.16, que un pg_restore 16 rechaza con "versión no
soportada". Restaurar contra el propio Postgres de Railway funciona; hacerlo
desde una máquina con cliente 16 no.

Un respaldo que nunca se restauró no es un respaldo, es una suposición:
conviene probar la restauración contra una base vacía de vez en cuando.

## Cómo desplegarlo

Desde un clon limpio del repositorio, **no desde el worktree**:

```
git clone https://github.com/Joeltcm/eleen-lifestyle.git && cd eleen-lifestyle
railway link --project eleen-lifestyle --environment production --service backup
railway up --service backup
```

`railway up` lanzado dentro de un worktree sube la copia principal del
repositorio, que puede estar muchos commits atrás. Así se rompió producción el
2026-08-30.
