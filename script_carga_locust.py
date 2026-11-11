"""
Proyecto final · Arquitectura Computacional · UCC Pasto
Generador de carga SOSTENIDA para la API de ventas (Locust).

Mezcla de operaciones (pesos de las tareas):
    10 %  login concurrente           POST /api/auth/login
    60 %  consulta de catálogo        GET  /api/productos?categoria=...
    30 %  compra concurrente          POST /api/ventas  (transacción BEGIN/COMMIT)

Perfil de carga (LoadTestShape):
    1. Rampa: sube de 0 a USUARIOS en RAMPA_SEG segundos.
    2. Meseta sostenida: mantiene USUARIOS durante SOSTENIDO_SEG segundos.
       El script NO permite menos de 300 s (5 minutos) de meseta: el curso
       exige carga sostenida de minutos, no ráfagas de diez segundos.
    3. Se detiene solo al terminar la meseta.

Instalación:
    python3 -m venv .venv && source .venv/bin/activate
    pip install "locust>=2.32"

Ejecución reproducible (sin interfaz web, con datos crudos en CSV):
    LOCUST_USUARIOS=300 LOCUST_RAMPA_SEG=60 LOCUST_SOSTENIDO_SEG=300 \
    locust -f script_carga_locust.py --headless \
           --host http://localhost:3000 \
           --csv resultados/local_corrida1 --csv-full-history \
           --html resultados/local_corrida1.html

    (No se pasa -u, -r ni --run-time: el perfil lo controla la clase
    CargaSostenida de abajo, y así todas las corridas son idénticas.)

Variables de entorno:
    LOCUST_USUARIOS        usuarios concurrentes en la meseta        (300)
    LOCUST_RAMPA_SEG       duración de la rampa en segundos          (60)
    LOCUST_SOSTENIDO_SEG   duración de la meseta, mínimo 300         (300)
    LOCUST_ESPERA_MIN      espera mínima entre tareas, segundos      (0.1)
    LOCUST_ESPERA_MAX      espera máxima entre tareas, segundos      (0.5)
    LOCUST_EMAIL           usuario vendedor                          (vendedor@tienda.local)
    LOCUST_PASSWORD        contraseña                                (Vendedor2026*)
    LOCUST_MUESTREO_SEG    cada cuánto leer /api/metricas            (5)
    LOCUST_DIR_RESULTADOS  carpeta para los CSV de métricas internas (resultados)

Además de los CSV de Locust (latencias p50/p95/p99 por endpoint y por
segundo), este script guarda resultados/metricas_api_<fecha>.csv con lo que la
propia API reporta cada LOCUST_MUESTREO_SEG segundos: retraso del Event Loop,
memoria residente (RSS), CPU del proceso y cola del pool de Postgres. Esos son
los datos crudos que se adjuntan al informe.
"""

from __future__ import annotations

import csv
import json
import os
import random
import time
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import gevent
import requests
from locust import HttpUser, LoadTestShape, between, events, task
from locust.env import Environment
from locust.runners import WorkerRunner


# ---------------------------------------------------------------------------
#  Parámetros
# ---------------------------------------------------------------------------
def _entero(nombre: str, por_defecto: int) -> int:
    valor = os.getenv(nombre, "")
    return int(valor) if valor.strip() else por_defecto


def _decimal(nombre: str, por_defecto: float) -> float:
    valor = os.getenv(nombre, "")
    return float(valor) if valor.strip() else por_defecto


MINIMO_SOSTENIDO_SEG = 300  # 5 minutos

USUARIOS = _entero("LOCUST_USUARIOS", 300)
RAMPA_SEG = _entero("LOCUST_RAMPA_SEG", 60)
SOSTENIDO_SEG = max(_entero("LOCUST_SOSTENIDO_SEG", 300), MINIMO_SOSTENIDO_SEG)
ESPERA_MIN = _decimal("LOCUST_ESPERA_MIN", 0.1)
ESPERA_MAX = _decimal("LOCUST_ESPERA_MAX", 0.5)
EMAIL = os.getenv("LOCUST_EMAIL", "vendedor@tienda.local")
PASSWORD = os.getenv("LOCUST_PASSWORD", "Vendedor2026*")
MUESTREO_SEG = _entero("LOCUST_MUESTREO_SEG", 5)
DIR_RESULTADOS = os.getenv("LOCUST_DIR_RESULTADOS", "resultados")

CATEGORIAS = ["tecnologia", "papeleria", "hogar", "alimentos", "bebidas", "deportes"]

# Ids de productos válidos (los 500 del seed). Se refina con lo que devuelve
# el catálogo, pero así una compra nunca depende de una consulta previa.
PRODUCTOS_SEMILLA: List[int] = list(range(1, 501))


# ---------------------------------------------------------------------------
#  Perfil de carga sostenida
# ---------------------------------------------------------------------------
class CargaSostenida(LoadTestShape):
    """Rampa lineal y meseta de al menos 5 minutos. Devuelve None para parar."""

    def tick(self) -> Optional[Tuple[int, float]]:
        t = self.get_run_time()
        if t < RAMPA_SEG:
            usuarios = max(1, int(USUARIOS * t / max(RAMPA_SEG, 1)))
            tasa = max(1.0, USUARIOS / max(RAMPA_SEG, 1))
            return usuarios, tasa
        if t < RAMPA_SEG + SOSTENIDO_SEG:
            return USUARIOS, max(1.0, USUARIOS / max(RAMPA_SEG, 1))
        return None


# ---------------------------------------------------------------------------
#  Usuario simulado: un vendedor en caja
# ---------------------------------------------------------------------------
class Vendedor(HttpUser):
    wait_time = between(ESPERA_MIN, ESPERA_MAX)
    # Una petición que tarda más de 30 s cuenta como fallo (el usuario ya se fue).
    connection_timeout = 10.0
    network_timeout = 30.0

    token: Optional[str] = None
    productos_vistos: List[int]

    def on_start(self) -> None:
        self.productos_vistos = []
        # Login inicial con nombre propio para no mezclarlo con el 10 % de la mezcla.
        self._login(nombre="/api/auth/login [inicio de sesión del usuario]")

    # ------------------------------------------------------------------ util
    def _cabeceras(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def _login(self, nombre: str) -> None:
        with self.client.post(
            "/api/auth/login",
            json={"email": EMAIL, "password": PASSWORD},
            name=nombre,
            catch_response=True,
        ) as r:
            if r.status_code == 200:
                try:
                    self.token = r.json()["token"]
                    r.success()
                except (ValueError, KeyError):
                    r.failure("Respuesta de login sin token")
            else:
                r.failure(f"Login falló con HTTP {r.status_code}")

    def _reautenticar_si_hace_falta(self, status: int) -> None:
        if status == 401:
            self._login(nombre="/api/auth/login [renovación]")

    # ----------------------------------------------------------------- tareas
    @task(1)
    def login_concurrente(self) -> None:
        """10 %: login. Verifica la contraseña con scrypt (CPU en el pool de libuv)."""
        self._login(nombre="/api/auth/login")

    @task(6)
    def consultar_catalogo(self) -> None:
        """60 %: lectura filtrada del catálogo por categoría."""
        categoria = random.choice(CATEGORIAS)
        pagina = random.choice([1, 1, 1, 2])  # la primera página es la más vista
        with self.client.get(
            f"/api/productos?categoria={categoria}&limite=50&pagina={pagina}",
            headers=self._cabeceras(),
            name="/api/productos?categoria=[slug]",
            catch_response=True,
        ) as r:
            if r.status_code == 200:
                try:
                    datos = r.json()
                    ids = [p["id"] for p in datos.get("productos", [])]
                    if ids:
                        # Se guardan algunos ids vistos para comprarlos después,
                        # como haría un vendedor real.
                        self.productos_vistos = (self.productos_vistos + random.sample(ids, min(5, len(ids))))[-40:]
                    r.success()
                except (ValueError, KeyError, TypeError):
                    r.failure("JSON de catálogo inválido")
            else:
                r.failure(f"HTTP {r.status_code}")
                self._reautenticar_si_hace_falta(r.status_code)

    @task(3)
    def comprar(self) -> None:
        """30 %: compra concurrente con transacción explícita en Postgres."""
        candidatos = self.productos_vistos if len(self.productos_vistos) >= 4 else PRODUCTOS_SEMILLA
        n_items = random.randint(1, 4)
        items = [
            {"productoId": pid, "cantidad": random.randint(1, 3)}
            for pid in random.sample(candidatos, n_items)
        ]
        with self.client.post(
            "/api/ventas",
            json={"items": items},
            headers=self._cabeceras(),
            name="/api/ventas",
            catch_response=True,
        ) as r:
            if r.status_code == 201:
                r.success()
            elif r.status_code == 409:
                r.failure("Stock insuficiente (409): reinicie la BD con base_de_datos.sql")
            else:
                r.failure(f"HTTP {r.status_code}")
                self._reautenticar_si_hace_falta(r.status_code)


# ---------------------------------------------------------------------------
#  Muestreo de métricas internas de la API durante la prueba
# ---------------------------------------------------------------------------
_muestreador: Optional[gevent.Greenlet] = None
_archivo_metricas: Optional[str] = None

COLUMNAS_METRICAS = [
    "timestamp", "segundo_prueba", "usuarios_activos", "rps_locust",
    "cpu_proceso_pct", "rss_mb", "heap_usado_mb",
    "loop_p50_ms", "loop_p95_ms", "loop_p99_ms", "loop_max_ms",
    "pool_total", "pool_libres", "pool_esperando", "peticiones_en_curso",
]


def _muestrear(environment: Environment) -> None:
    global _archivo_metricas
    host = (environment.host or "http://localhost:3000").rstrip("/")
    os.makedirs(DIR_RESULTADOS, exist_ok=True)
    _archivo_metricas = os.path.join(DIR_RESULTADOS, f"metricas_api_{datetime.now():%Y%m%d_%H%M%S}.csv")
    inicio = time.time()
    with open(_archivo_metricas, "w", newline="", encoding="utf-8") as f:
        escritor = csv.writer(f)
        escritor.writerow(COLUMNAS_METRICAS)
        while True:
            try:
                m: Dict[str, Any] = requests.get(f"{host}/api/metricas", timeout=5).json()
                stats = environment.stats.total if environment.stats else None
                runner = environment.runner
                escritor.writerow([
                    datetime.now().isoformat(timespec="seconds"),
                    round(time.time() - inicio),
                    runner.user_count if runner else 0,
                    round(stats.current_rps, 1) if stats else 0,
                    m["cpuProcesoPorcentaje"],
                    m["memoriaMB"]["rss"],
                    m["memoriaMB"]["heapUsado"],
                    m["eventLoopRetrasoMs"]["p50"],
                    m["eventLoopRetrasoMs"]["p95"],
                    m["eventLoopRetrasoMs"]["p99"],
                    m["eventLoopRetrasoMs"]["max"],
                    m["pool"]["total"],
                    m["pool"]["libres"],
                    m["pool"]["esperando"],
                    m["peticiones"]["enCurso"],
                ])
                f.flush()
            except (requests.RequestException, ValueError, KeyError) as error:
                print(f"[metricas] No se pudo leer /api/metricas: {error}")
            gevent.sleep(MUESTREO_SEG)


@events.test_start.add_listener
def _al_iniciar(environment: Environment, **_: Any) -> None:
    global _muestreador
    print("=" * 72)
    print(f" Carga sostenida: {USUARIOS} usuarios · rampa {RAMPA_SEG}s · meseta {SOSTENIDO_SEG}s")
    print(f" Mezcla: 10 % login · 60 % catálogo · 30 % compras · espera {ESPERA_MIN}-{ESPERA_MAX}s")
    print(f" Destino: {environment.host}")
    print("=" * 72)
    if not isinstance(environment.runner, WorkerRunner) and _muestreador is None:
        _muestreador = gevent.spawn(_muestrear, environment)


@events.test_stop.add_listener
def _al_detener(environment: Environment, **_: Any) -> None:
    global _muestreador
    if _muestreador is not None:
        _muestreador.kill(block=False)
        _muestreador = None


@events.quitting.add_listener
def _resumen(environment: Environment, **_: Any) -> None:
    if isinstance(environment.runner, WorkerRunner):
        return
    stats = environment.stats
    filas = sorted(stats.entries.values(), key=lambda e: e.name)
    print("\n" + "=" * 100)
    print(" RESUMEN (latencias en ms; percentiles calculados por Locust sobre TODA la corrida)")
    print("=" * 100)
    print(f"{'Endpoint':48} {'peticiones':>10} {'fallos':>7} {'req/s':>7} {'p50':>6} {'p95':>6} {'p99':>6} {'máx':>7}")
    resumen: List[Dict[str, Any]] = []
    for e in filas + [stats.total]:
        nombre = "TOTAL" if e is stats.total else f"{e.method} {e.name}"
        fila = {
            "endpoint": nombre,
            "peticiones": e.num_requests,
            "fallos": e.num_failures,
            "rps": round(e.total_rps, 1),
            "p50": e.get_response_time_percentile(0.50),
            "p95": e.get_response_time_percentile(0.95),
            "p99": e.get_response_time_percentile(0.99),
            "max": round(e.max_response_time or 0),
        }
        resumen.append(fila)
        print(f"{nombre[:48]:48} {fila['peticiones']:>10} {fila['fallos']:>7} {fila['rps']:>7} "
              f"{fila['p50']:>6} {fila['p95']:>6} {fila['p99']:>6} {fila['max']:>7}")
    print("=" * 100)
    if _archivo_metricas:
        print(f" Métricas internas de la API: {_archivo_metricas}")
    os.makedirs(DIR_RESULTADOS, exist_ok=True)
    ruta = os.path.join(DIR_RESULTADOS, f"resumen_{datetime.now():%Y%m%d_%H%M%S}.json")
    with open(ruta, "w", encoding="utf-8") as f:
        json.dump({
            "usuarios": USUARIOS, "rampa_seg": RAMPA_SEG, "sostenido_seg": SOSTENIDO_SEG,
            "espera_seg": [ESPERA_MIN, ESPERA_MAX], "host": environment.host, "endpoints": resumen,
        }, f, ensure_ascii=False, indent=2)
    print(f" Resumen JSON: {ruta}\n")
    # Si hubo más de 1 % de fallos, Locust sale con código distinto de cero.
    if stats.total.num_requests and stats.total.num_failures / stats.total.num_requests > 0.01:
        environment.process_exit_code = 1

