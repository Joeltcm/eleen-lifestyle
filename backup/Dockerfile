# Servicio de backup: pg_dump (v16) → Cloudflare R2, con rotación.
# Se ejecuta como Cron Job en Railway (corre, sube el dump y se apaga).
# pg_dump 18: puede dumpear servidores v16, v17 y v18 (compatibilidad hacia atrás).
FROM postgres:18

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --break-system-packages --no-cache-dir boto3 \
 && rm -rf /var/lib/apt/lists/*

# railway up sube la raíz del repositorio, no esta carpeta: el contexto de
# construcción empieza un nivel más arriba.
COPY backup/backup.py /backup.py
CMD ["python3", "/backup.py"]
