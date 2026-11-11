#!/usr/bin/env bash
# =============================================================================
#  Proyecto final · Arquitectura Computacional · UCC Pasto
#  Captura de datos crudos de hardware MIENTRAS corre la prueba de Locust.
#
#  Uso:
#    ./medir_recursos.sh <etiqueta> <duración_segundos> [contenedor_docker]
#
#  Ejemplos:
#    ./medir_recursos.sh local_corrida1 360
#    ./medir_recursos.sh ec2_t3micro_corrida1 360
#    ./medir_recursos.sh docker_05cpu_corrida1 360 tienda-api
#
#  Arránquelo en otra terminal justo cuando Locust termine la rampa (60 s).
#  Requiere: sysstat (pidstat, iostat, sar, mpstat), procps (vmstat, top).
#    sudo apt install -y sysstat
#
#  Todo queda en resultados/<etiqueta>/ como texto plano: esos archivos son los
#  "datos crudos" que exige la rúbrica y se adjuntan con el informe.
# =============================================================================
set -euo pipefail

ETIQUETA="${1:?Indique una etiqueta, p. ej. local_corrida1}"
DURACION="${2:?Indique la duración en segundos, p. ej. 360}"
CONTENEDOR="${3:-}"
DIR="resultados/${ETIQUETA}"
mkdir -p "$DIR"

for cmd in pidstat iostat vmstat mpstat sar; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Falta $cmd (sudo apt install -y sysstat procps)"; exit 1; }
done

# --- Entorno completo (la sesión 10 pide anotarlo) ----------------------------
{
  echo "fecha_inicio: $(date -Is)"
  echo "host: $(hostname)"
  echo "kernel: $(uname -r)"
  echo "--- lscpu"; lscpu
  echo "--- memoria"; free -m
  echo "--- discos"; lsblk -d -o NAME,MODEL,ROTA,SIZE,TRAN 2>/dev/null || true
  echo "--- node"; node -v 2>/dev/null || echo "node no está en el host"
  echo "--- postgres"; psql --version 2>/dev/null || echo "psql no está en el host"
  echo "--- cgroups"; stat -fc %T /sys/fs/cgroup
  if [ -n "$CONTENEDOR" ]; then
    echo "--- límites del contenedor $CONTENEDOR"
    docker inspect -f 'NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}}' "$CONTENEDOR"
  fi
} > "$DIR/entorno.txt" 2>&1

# --- PID de la API -----------------------------------------------------------
if [ -n "$CONTENEDOR" ]; then
  PID_API="$(docker inspect -f '{{.State.Pid}}' "$CONTENEDOR")"
  ID_COMPLETO="$(docker inspect -f '{{.Id}}' "$CONTENEDOR")"
  CGROUP="$(ls -d /sys/fs/cgroup/system.slice/docker-"${ID_COMPLETO}".scope 2>/dev/null || true)"
else
  PID_API="$(pgrep -f 'node .*dist/server.js' | head -n1 || true)"
  CGROUP=""
fi
[ -n "$PID_API" ] || { echo "No encontré el proceso de la API (node dist/server.js)"; exit 1; }
PIDS_PG="$(pgrep -d, -x postgres || true)"
echo "pid_api: $PID_API" >> "$DIR/entorno.txt"
echo "pids_postgres: $PIDS_PG" >> "$DIR/entorno.txt"

if [ -n "$CGROUP" ]; then
  cat "$CGROUP/cpu.max"  > "$DIR/cgroup_cpu_max.txt"
  cat "$CGROUP/cpu.stat" > "$DIR/cgroup_cpu_stat_inicio.txt"
  cat "$CGROUP/memory.max" > "$DIR/cgroup_memory_max.txt"
fi

echo "Midiendo ${DURACION}s → $DIR (API pid ${PID_API})"

# --- Capturas en paralelo, una muestra por segundo ---------------------------
vmstat -t 1 "$DURACION"                       > "$DIR/vmstat.txt" &
mpstat -P ALL 1 "$DURACION"                   > "$DIR/mpstat_por_nucleo.txt" &
iostat -x -t 1 "$DURACION"                    > "$DIR/iostat.txt" &
sar -n DEV 1 "$DURACION"                      > "$DIR/red_sar.txt" &
pidstat -u -r -d -h -p "$PID_API" 1 "$DURACION" > "$DIR/pidstat_api.txt" &
pidstat -t -u -p "$PID_API" 5 $((DURACION / 5)) > "$DIR/pidstat_hilos_api.txt" &
pidstat -w -p "$PID_API" 1 "$DURACION"        > "$DIR/pidstat_cambios_contexto.txt" &
if [ -n "$PIDS_PG" ]; then
  pidstat -u -r -d -h -p "$PIDS_PG" 5 $((DURACION / 5)) > "$DIR/pidstat_postgres.txt" &
fi
if [ -n "$CONTENEDOR" ]; then
  (
    fin=$((SECONDS + DURACION))
    while [ $SECONDS -lt $fin ]; do
      docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}}' >> "$DIR/docker_stats.csv"
      sleep 1
    done
  ) &
fi
# Foto de top cada 30 s (us, sy, wa, id, st y RES del proceso)
(
  fin=$((SECONDS + DURACION))
  while [ $SECONDS -lt $fin ]; do
    top -b -n 1 -p "$PID_API" | head -n 12 >> "$DIR/top_cada_30s.txt"
    echo "----" >> "$DIR/top_cada_30s.txt"
    sleep 30
  done
) &

wait

if [ -n "$CGROUP" ]; then
  cat "$CGROUP/cpu.stat" > "$DIR/cgroup_cpu_stat_fin.txt"
  echo "Throttling (nr_throttled / nr_periods):"
  paste "$DIR/cgroup_cpu_stat_inicio.txt" "$DIR/cgroup_cpu_stat_fin.txt"
fi

# --- Resumen rápido ----------------------------------------------------------
{
  echo "== Promedios de vmstat (us sy id wa st) =="
  awk 'NR>2 && $1 ~ /^[0-9]+$/ {us+=$13; sy+=$14; id+=$15; wa+=$16; st+=$17; n++}
       END {if (n) printf "us=%.1f sy=%.1f id=%.1f wa=%.1f st=%.1f (n=%d)\n", us/n, sy/n, id/n, wa/n, st/n, n}' "$DIR/vmstat.txt"
  echo "== Promedio de pidstat de la API (%CPU, RSS kB) =="
  awk '$1 !~ /^#/ && NF > 10 && $2 ~ /^[0-9]+$/ {cpu+=$8; rss+=$13; n++}
       END {if (n) printf "%%CPU=%.1f RSS_kB=%.0f (n=%d)\n", cpu/n, rss/n, n}' "$DIR/pidstat_api.txt"
} | tee "$DIR/resumen_rapido.txt"

echo "Listo. Datos crudos en $DIR"
