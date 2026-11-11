# Dimensionar una carga real: ¿dónde espera nuestra API de ventas?

**Proyecto final · Arquitectura Computacional · Universidad Cooperativa de Colombia, sede Pasto**
**Momento evaluativo 3 · Periodo 2620**
**Integrantes:** _[Nombre completo 1]_ · _[Nombre completo 2]_ — **Grupo:** _[5A / 5B]_
**Fecha de sustentación:** _[11 o 18 de noviembre de 2026]_

---

> ### ⚠️ Aviso sobre los datos de este borrador
>
> Las tablas de las secciones 4 a 8 marcadas con **(ILUSTRATIVO)** contienen **datos simulados**, construidos para ser coherentes con el comportamiento real de Node.js y PostgreSQL bajo esta carga. **No son mediciones nuestras y no se pueden entregar así.** La rúbrica es explícita: _"Números tomados de internet no cuentan"_, y lo mismo vale para números inventados.
>
> **Antes de entregar:** corran `script_carga_locust.py` y `medir_recursos.sh` en los tres entornos (sección 3.4), reemplacen cada número marcado como ILUSTRATIVO por el suyo, ajusten las conclusiones si sus datos dicen otra cosa, borren este aviso y adjunten la carpeta `resultados/` completa.
>
> El **Anexo A** sí contiene una corrida real: la que hicimos para validar que los guiones funcionan, en una máquina virtual de desarrollo. Sirve como referencia de orden de magnitud, pero tampoco reemplaza sus tres entornos.

---

## 1. Introducción

La pregunta que ordena este trabajo es la del curso: **¿en qué máquina debería correr esta aplicación, y con qué datos lo sostenemos?** No buscamos adivinar la máquina "correcta"; buscamos que cada afirmación tenga detrás un número que medimos y que podamos señalar el componente del computador que lo causa: la caché, los IOPS, el límite del contenedor o la parte secuencial del programa.

La aplicación es un **sistema de ventas para una tienda** construido por nosotros, con tres operaciones que estresan componentes distintos a propósito:

| Operación | Endpoint | Peso en la carga | Componente que estresa |
|---|---|---|---|
| Iniciar sesión | `POST /api/auth/login` | 10 % | **CPU**: scrypt (N=4096, r=8, p=1) en el pool de hilos de libuv |
| Consultar catálogo | `GET /api/productos?categoria=…` | 60 % | **CPU del hilo principal** (JWT, conversión de filas, `JSON.stringify`) y **red** (~12 KB por respuesta) |
| Registrar venta | `POST /api/ventas` | 30 % | **Disco** (WAL + `fsync` en cada `COMMIT`) y **contención** (bloqueos de fila `FOR UPDATE`) |

El resultado principal, que se desarrolla en la sección 5, es que **la aplicación espera por CPU, y concretamente por un solo núcleo**: el hilo del Event Loop de Node.js. El disco y la red están lejos de su límite. Esa conclusión explica por qué el contenedor de 0,5 vCPU colapsa, por qué la t3.micro no sostiene la carga y por qué agregar núcleos sin cambiar el programa rinde poco (Amdahl).

## 2. La aplicación y su arquitectura

```
 Locust (otra máquina)                      Servidor bajo prueba
 ┌──────────────────┐   HTTP/1.1 keep-alive ┌───────────────────────────────────────────┐
 │ 300 usuarios     │ ────────────────────▶ │ Node.js 20 · Express · TypeScript          │
 │ 10/60/30 %       │                       │  ├─ Hilo principal (Event Loop): JS, JWT,  │
 │ espera 0,1–0,5 s │ ◀──────────────────── │  │   JSON, Express                          │
 └──────────────────┘                       │  └─ libuv threadpool (4 hilos): scrypt     │
                                            │        │ pool de 20 conexiones TCP          │
                                            │        ▼                                    │
                                            │ PostgreSQL 16 (un proceso por conexión)     │
                                            │  shared_buffers 128 MB · WAL · fsync        │
                                            └───────────────────────────────────────────┘
```

**Backend** (`proyecto/backend`): Express con TypeScript estricto, organizado por módulos (`auth`, `productos`, `ventas`). Todas las rutas de productos y ventas verifican el JWT (HMAC-SHA256) en cada petición. La venta se registra en **una transacción explícita** `BEGIN … COMMIT` con 10 sentencias: lectura de validación con `SELECT … FOR UPDATE` en orden de id (evita interbloqueos), encabezado, detalle, descuento de stock, kárdex de inventario, total y una relectura de validación. Si algo no cuadra, `ROLLBACK`. Si Postgres detecta un interbloqueo (`40P01`), la transacción se reintenta.

**Base de datos** (`base_de_datos.sql`): usuarios con rol (`admin`, `vendedor`), 6 categorías, 500 productos (24 reales y 476 generados) con 1.000.000 de unidades cada uno para que la prueba no agote inventario, ventas, detalle y kárdex.

**Frontend** (`proyecto/frontend`): React + Vite + TypeScript. Login que guarda el JWT en `localStorage`, panel de vendedor con catálogo filtrado, carrito local y compra (incluida una "compra masiva" que dispara el mismo carrito N veces en paralelo), y panel de administrador con inventario y resumen de ventas. El frontend no forma parte de la carga medida: la prueba ataca la API directamente.

**Instrumentación propia:** `GET /api/metricas` expone desde dentro del proceso el **retraso del Event Loop** (p50/p95/p99, con `perf_hooks.monitorEventLoopDelay`), la memoria residente, la CPU del proceso y la **cola del pool de Postgres** (`waitingCount`). Locust la muestrea cada 5 s y la guarda en CSV.

## 3. Metodología

### 3.1 Generación de la carga

- **Herramienta:** Locust 2.x, `script_carga_locust.py`, ejecutado **desde otra máquina** para que el generador no le robe CPU al servidor medido (portátil en la misma LAN cableada a 1 Gb/s para los entornos local y Docker; una instancia t3.medium en la misma zona de disponibilidad para la nube).
- **Perfil (clase `CargaSostenida`):** rampa de 0 a 300 usuarios en 60 s y **meseta de 300 s** (el script no acepta menos de 5 minutos). Los números se toman solo en la meseta.
- **Usuarios:** cada uno inicia sesión al empezar y luego elige tareas con pesos 1 : 6 : 3 (10 % login, 60 % catálogo, 30 % compra), esperando entre 0,1 y 0,5 s entre una y otra. Es un sistema **de lazo cerrado**: si el servidor se pone lento, cada usuario envía menos peticiones. Por eso el caudal y la latencia se deben leer juntos: λ ≈ usuarios / (espera media + latencia media) = 300 / (0,3 s + R̄).
- **Compras:** de 1 a 4 productos, 1 a 3 unidades cada uno, elegidos entre los que el usuario vio en el catálogo.
- **Repetición:** cada entorno se corre **3 veces**, reiniciando la base con `base_de_datos.sql` antes de cada corrida; se reporta la **mediana** de las tres (sesión 10: "repetir y quedarse con la mediana").
- **Objetivo de servicio (SLO)** con el que juzgamos si un entorno "aguanta": **p99 < 500 ms y menos de 1 % de errores** sostenidos durante la meseta.

Comando exacto (idéntico en los tres entornos, solo cambia `--host`):

```bash
LOCUST_USUARIOS=300 LOCUST_RAMPA_SEG=60 LOCUST_SOSTENIDO_SEG=300 \
locust -f script_carga_locust.py --headless --host http://<servidor>:3000 \
       --csv resultados/<entorno>_corrida<N> --csv-full-history --html resultados/<entorno>_corrida<N>.html
```

### 3.2 Instrumentos de medición del sistema operativo

`medir_recursos.sh <etiqueta> 360 [contenedor]` se lanza en el servidor al terminar la rampa y captura todo a 1 muestra por segundo:

| Qué | Comando | Qué columna miramos | Por qué |
|---|---|---|---|
| Visión general | `top`, `htop`, `vmstat 1` | `us`, `sy`, `wa`, `id`, `st`; `r` (cola de ejecución), `cs` | Distingue cálculo (`us`) de espera de disco (`wa`) y de robo del hipervisor (`st`) |
| CPU por núcleo | `mpstat -P ALL 1` | `%usr` de cada CPU | Ver si hay **un** núcleo al tope mientras los demás descansan |
| CPU del proceso | `pidstat -u -p <pid> 1` | `%usr`, `%system`, `%CPU` | Cuánto consume la API, separado de Postgres |
| CPU por hilo | `pidstat -t -u -p <pid> 5` | `%CPU` del hilo `node` vs hilos `libuv-worker` | **La prueba de que el Event Loop es un solo hilo** |
| Memoria residente | `pidstat -r -p <pid> 1`, `top` → `RES` | `RSS` | Lo que de verdad ocupa, no lo que reserva (`VSZ`) |
| Cambios de contexto | `pidstat -w -p <pid> 1` | `cswch/s`, `nvcswch/s` | Involuntarios altos = el núcleo le quita la CPU (throttling o vecinos) |
| Disco | `iostat -x 1` | `w/s` (IOPS), `wkB/s` (caudal), `w_await`, `aqu-sz`, `%util` | Si el disco está saturado, `%util` → 100 % y `w_await` sube |
| Red | `sar -n DEV 1` | `rxkB/s`, `txkB/s` de la interfaz | Comparar con el ancho de banda de la ficha técnica |
| Contenedor | `docker stats`, `cpu.stat` del cgroup | `CPU %`, `MEM USAGE / LIMIT`; `nr_throttled`, `throttled_usec` | La evidencia directa del throttling del CFS |
| Nube | CloudWatch | `CPUUtilization`, `CPUCreditBalance`, `CPUSurplusCreditsCharged` | Ver el agotamiento de créditos de la instancia burstable |
| Latencia | Locust (CSV) | p50, p95, p99 por endpoint | Lo único que siente el usuario; **nunca el promedio** |

### 3.3 Los tres entornos (fichas técnicas)

| | **E1 · Máquina física local** | **E2 · AWS EC2 t3.micro** | **E3 · Contenedor Docker con límites** |
|---|---|---|---|
| Procesador | _[ILUSTRATIVO: AMD Ryzen 5 5600H, 6 núcleos / 12 hilos, 3,3–4,2 GHz]_ | Intel Xeon Platinum serie 8000 (Skylake/Cascade Lake), hasta 3,1 GHz | El mismo host de E1 |
| vCPU / núcleos | 12 hilos sobre 6 núcleos físicos | **2 vCPU = 1 núcleo físico con 2 hilos (Hyper-Threading)** | **0,5 vCPU**: `cpu.max = 50000 100000` (cgroups v2, CFS) |
| Caché | L2 512 KB/núcleo, L3 16 MB | L3 compartida con otros clientes del servidor físico | La del host, compartida con todo lo que corra en él |
| RAM | 16 GB DDR4-3200 | **1 GiB** | **512 MB**, sin swap (`memory.max`, `memswap_limit`) |
| Disco | NVMe PCIe 3.0 local, 512 GB | EBS gp3 20 GiB: 3.000 IOPS y 125 MB/s de línea base, **por red** | El NVMe del host (volumen Docker) |
| Red | Ethernet 1 Gb/s | "Hasta 5 Gb/s" con créditos; línea base ≈ 0,064 Gb/s | Puente Docker sobre la red del host |
| Modelo de CPU | Dedicada | **Burstable**: línea base 10 % por vCPU, gana 12 créditos/h, máx. 288 | Cuota fija por ventanas de 100 ms |
| Postgres | Nativo en el host | Nativo en la misma instancia | Contenedor aparte: 1 vCPU, 512 MB |
| Precio | Equipo propio (ver 6.3) | USD 0,0104/h → **USD 7,59/mes** de cómputo + 1,60 de EBS gp3 + 3,65 de IPv4 pública = **USD 12,84/mes** (us-east-1, bajo demanda, Linux) | Referencia: AWS Fargate 0,5 vCPU / 1 GB ≈ **USD 18,02/mes** |

> **Sobre el precio de la t3.micro.** En la propuesta usamos USD 10,22/mes. El desglose de lista de us-east-1 da 7,59 (cómputo) + 1,60 (20 GiB gp3) = 9,19, y 12,84 si se cuenta la IPv4 pública, que AWS cobra aparte desde 2024. **Verifiquen el precio en la calculadora de AWS para su región, anoten la fecha de consulta y usen esa cifra.** Si la instancia corre en modo _unlimited_ (el predeterminado de la familia t3), se suma el costo de los créditos excedentes (sección 7).

**Software idéntico en todos:** Ubuntu 22.04 (kernel 6.x), Node.js 20 LTS, PostgreSQL 16 con configuración por defecto (`shared_buffers = 128MB`, `synchronous_commit = on`), `PG_POOL_MAX = 20`, `UV_THREADPOOL_SIZE = 4`.

### 3.4 Procedimiento paso a paso

1. `psql -d tienda_carga -f base_de_datos.sql` (estado inicial idéntico).
2. `cd proyecto/backend && npm ci && npm run build && node dist/server.js` (en E3: `docker compose up -d --build` desde `proyecto/`).
3. Calentamiento: 60 s de carga que se descartan, para que el JIT de V8 compile las rutas calientes y la caché de Postgres se llene.
4. En la máquina de carga: el comando de Locust de 3.1.
5. En el servidor, a los 60 s: `./medir_recursos.sh <entorno>_corrida<N> 300 [tienda-api]`.
6. Repetir 2–5 tres veces. En E2, además, una corrida larga de 30 minutos (sección 7).

### 3.5 Los cuatro errores que evitamos (sesión 10)

| Error | Cómo lo evitamos |
|---|---|
| Medir en reposo | Toda medición se toma durante la meseta de 300 usuarios |
| Medir una sola vez | Tres corridas por entorno, se reporta la mediana |
| Reportar el promedio | Reportamos p50, p95 y p99 por endpoint |
| Medir demasiado poco | 5 minutos de meseta mínimo, y 30 minutos en la nube para ver los créditos |

## 4. Datos crudos **(ILUSTRATIVO — reemplazar)**

### 4.1 Repetibilidad en E1 (tres corridas)

| Corrida | Peticiones | Caudal (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | Errores |
|---|---|---|---|---|---|---|
| 1 | 261.300 | 871 | 24 | 150 | 260 | 0 |
| 2 | 259.200 | 864 | 25 | 158 | 274 | 0 |
| 3 | 262.800 | 876 | 23 | 146 | 251 | 0 |
| **Mediana** | — | **871** | **24** | **150** | **260** | **0 %** |

La dispersión entre corridas es menor al 5 %: la medición es estable.

### 4.2 Latencia por endpoint (mediana de 3 corridas, en ms)

| Endpoint | E1 local p50 / p95 / p99 | E2 t3.micro p50 / p95 / p99 | E3 Docker 0,5 vCPU p50 / p95 / p99 |
|---|---|---|---|
| Login | 38 / 98 / 170 | 390 / 1.160 / 1.720 | 940 / 3.100 / 4.600 |
| Catálogo | 17 / 66 / 128 | 240 / 860 / 1.290 | 610 / 2.150 / 3.300 |
| Venta | 64 / 190 / 310 | 520 / 1.380 / 1.950 | 820 / 2.700 / 4.100 |
| **Global** | **24 / 150 / 260** | **310 / 1.020 / 1.480** | **690 / 2.350 / 3.600** |
| Caudal total | 871 req/s | 402 req/s | 238 req/s |
| ¿Cumple el SLO (p99 < 500 ms)? | **Sí** | **No** | **No** |

### 4.3 Recursos durante la meseta (promedio de 300 muestras de 1 s, mediana de 3 corridas)

| Métrica | Comando | E1 local | E2 t3.micro | E3 Docker 0,5 vCPU |
|---|---|---|---|---|
| CPU global `us / sy / wa / id / st` | `vmstat 1` | 19,2 / 4,6 / 0,9 / 75,1 / 0,0 | 71,8 / 15,9 / 2,1 / 6,8 / 3,4 | (host) 8,1 / 2,0 / 0,3 / 89,6 / 0,0 |
| CPU del proceso `node` | `pidstat -u` | 168 % | 141 % | 49,8 % (`docker stats`) |
| — hilo principal (Event Loop) | `pidstat -t` | **92 %** | **97 %** | ≈ 26 % efectivo (congelado el resto) |
| — 4 hilos libuv (scrypt) | `pidstat -t` | 4 × 17,6 % | 4 × 9,8 % | ≈ 4 × 5 % |
| CPU de Postgres (todos sus procesos) | `pidstat -u` | 95 % | 52 % | 31 % |
| Retraso del Event Loop p50 / p99 | `/api/metricas` | 3,9 / 39 ms | 46 / 182 ms | 38 / 104 ms |
| Memoria residente `node` | `pidstat -r` (RSS) | 188 MB | 176 MB | 176 MiB de 512 MiB |
| Memoria Postgres (PSS) | `smem` | 330 MB | 290 MB | 241 MiB de 512 MiB |
| `MemAvailable` del sistema | `free -m` | 12.900 MB | 310 MB | — |
| IOPS de escritura | `iostat -x` → `w/s` | 1.240 | 640 | 410 |
| Caudal de escritura | `iostat -x` → `wkB/s` | 9.800 kB/s | 5.100 kB/s | 3.300 kB/s |
| Latencia de escritura | `iostat -x` → `w_await` | 0,06 ms | 0,62 ms | 0,06 ms |
| Utilización del disco | `iostat -x` → `%util` | 14 % | 31 % | 4 % |
| Lecturas de disco | `iostat -x` → `r/s` | 2 | 3 | 1 |
| Red saliente / entrante | `sar -n DEV` | 6,6 MB/s / 0,9 MB/s | 3,1 MB/s / 0,4 MB/s | 1,8 MB/s / 0,3 MB/s |
| Cambios de contexto involuntarios `node` | `pidstat -w` | 180 /s | 1.900 /s | 2.400 /s |
| Cola del pool de Postgres (`waitingCount`) p95 | `/api/metricas` | 6 | 0 | 0 |

### 4.4 Fragmentos de salida cruda (ILUSTRATIVO)

`pidstat -t -u -p $(pgrep -f dist/server.js) 5` en E1, durante la meseta:

```
Time      TGID   TID    %usr %system  %guest   %wait    %CPU   CPU  Command
14:22:35  48211      -  141,20   26,80    0,00    0,00  168,00     7  node
14:22:35      -  48211   79,40   12,60    0,00    2,20   92,00     7  |__node
14:22:35      -  48215    1,80    0,40    0,00    0,00    2,20     3  |__node        (V8 GC)
14:22:35      -  48218   16,20    1,40    0,00    0,40   17,60     9  |__libuv-worker
14:22:35      -  48219   16,00    1,60    0,00    0,20   17,60     1  |__libuv-worker
14:22:35      -  48220   16,40    1,20    0,00    0,60   17,60    11  |__libuv-worker
14:22:35      -  48221   15,80    1,80    0,00    0,40   17,60     4  |__libuv-worker
```

`iostat -x 1` en E1 (NVMe):

```
Device   r/s   rkB/s   w/s     wkB/s   w_await  aqu-sz  %util
nvme0n1  2,0   16,0    1240,0  9800,0  0,06     0,12    14,0
```

`cat cpu.stat` del cgroup de `tienda-api` en E3, al final de una corrida de 360 s:

```
usage_usec 179640000
nr_periods 3600
nr_throttled 3402
throttled_usec 161200000
```

`docker stats` en E3:

```
NAME         CPU %    MEM USAGE / LIMIT    NET I/O          BLOCK I/O
tienda-api   49,81%   176,4MiB / 512MiB    612MB / 98MB     0B / 0B
tienda-bd    31,20%   241,0MiB / 512MiB    95MB / 590MB     0B / 1,21GB
```

## 5. Identificación científica del cuello de botella

### 5.1 Diagnóstico por descarte (los cuatro sospechosos de la sesión 8)

| Sospechoso | La señal que buscaríamos | Lo que medimos en E1 | Veredicto |
|---|---|---|---|
| **Disco** | `wa` alto, `%util` → 100 %, `w_await` creciendo | `wa` = 0,9 %, `%util` = 14 %, `w_await` = 0,06 ms | **Descartado.** El NVMe hace 1.240 IOPS de los cientos de miles que admite |
| **Red** | CPU y disco tranquilos pero latencia alta; interfaz cerca de su capacidad | 6,6 MB/s = 53 Mb/s de 1.000 Mb/s (5 %) | **Descartado** a esta carga |
| **CPU** | `us` alto, `wa` bajo, **un núcleo al tope** | Global solo 19 % `us`, pero el **hilo principal de node al 92 %** | **Este es.** No es "la CPU": es **un núcleo** |
| **Contención** | Todo tranquilo y aun así lento | Cola del pool p95 = 6; bloqueos de fila en ventas | Secundario: amplifica la latencia de las ventas, pero no es lo que fija el techo |

El error clásico sería leer el 75 % de `id` en `vmstat` y concluir "sobra CPU". La CPU global está ociosa porque Node no puede usar más de un núcleo para su JavaScript: el hilo del Event Loop está al 92 % mientras 10 de los 12 hilos de hardware no tienen nada que hacer. **"Es CPU porque el hilo principal de node está en 92 % de `%CPU` en `pidstat -t`, con `wa` en 0,9 %."**

### 5.2 El Event Loop como una cola con un solo servidor

El hilo principal atiende el trabajo síncrono de todas las peticiones de una en una. Es una cola con **un solo servidor**, y la teoría de colas da su comportamiento.

**Tiempo de servicio** en el hilo principal, estimado por endpoint (perfil con `node --cpu-prof` y división de la CPU medida entre el caudal):

| Endpoint | λ (req/s) | S en el hilo principal | Trabajo que lo compone |
|---|---|---|---|
| Catálogo | 522,6 | 1,05 ms | Verificar JWT (≈ 0,04 ms), convertir 50 filas, `JSON.stringify` de ≈ 12 KB, Express y HTTP |
| Venta | 261,3 | 0,95 ms | 10 respuestas de Postgres que parsear, validar y serializar |
| Login | 87,1 | 0,35 ms | El scrypt **no** va aquí: va al pool de libuv |

**Utilización** del hilo:

$$\rho = \sum_i \lambda_i S_i = 522{,}6(1{,}05) + 261{,}3(0{,}95) + 87{,}1(0{,}35) \approx 827\ \text{ms por segundo} \approx 0{,}83$$

más ≈ 9 % del recolector de basura de V8, que también corre en ese hilo: **ρ ≈ 0,92**, que coincide con el 92 % de `pidstat -t`. Dos fuentes independientes, el mismo número.

**Por qué la latencia sube tanto con ρ cerca de 1.** En una cola M/M/1, el tiempo medio de espera antes de ser atendido es

$$W_q = \frac{\rho}{1-\rho}\, S$$

Con S̄ ≈ 1 ms: con ρ = 0,5 se espera 1 ms; con ρ = 0,8, 4 ms; con ρ = 0,92, **11,5 ms**; con ρ = 0,98, 49 ms. La curva es hiperbólica: los últimos puntos de utilización cuestan muchísima latencia. Esa espera la medimos directamente: es el **retraso del Event Loop**, con p50 = 3,9 ms y p99 = 39 ms en E1.

**Por qué las ventas sufren más que el catálogo.** Cada vez que Postgres responde, el *callback* vuelve a la cola del Event Loop. Una consulta de catálogo pasa por la cola 2 veces (petición y resultado). Una venta pasa **11 veces** (petición + 10 sentencias). Así, con un retraso medio de ≈ 6 ms por paso:

- Catálogo ≈ 2 × 6 + 1,1 (servicio) + 1,6 (Postgres) + red ≈ 15 ms → p50 medido 17 ms.
- Venta ≈ 11 × 6 + 1 + 8 (Postgres, incluido el `fsync` y la espera por bloqueos) ≈ 75 ms → media medida 82 ms, p50 64 ms.

La venta no es lenta por el disco: es lenta porque **hace once filas en la misma cola**.

**Ley de Little** para verificar la coherencia del conjunto: peticiones simultáneas dentro del servidor L = λ · R̄ = 871 req/s × 0,044 s ≈ **38**. En el pool de Postgres: L = 261 ventas/s × ≈ 0,03 s con conexión tomada + las lecturas ≈ 14–20 conexiones ocupadas en promedio de 20 disponibles. Por eso aparece cola en el pool (p95 = 6 en espera): el pool está al borde y es lo siguiente que se rompe (sección 8).

### 5.3 Amdahl: por qué más núcleos no ayudan

Del trabajo de CPU de la API, la parte que se puede repartir entre núcleos es el scrypt (va a 4 hilos de libuv). El resto es secuencial en el Event Loop. Con los datos de E1: 92 % de un núcleo en el hilo principal y 70 % repartido en libuv, la fracción paralelizable es p ≈ 0,70 / 1,62 ≈ 0,43. El límite de Amdahl con infinitos núcleos:

$$\text{Aceleración máxima} = \frac{1}{1-p} = \frac{1}{0{,}57} \approx 1{,}75\times$$

Pasar de 6 a 64 núcleos no cambia el techo: lo fija el único hilo del Event Loop. Para pasar ese límite hay que **cambiar el programa**, no la máquina: varios procesos con `node:cluster` o PM2 (uno por núcleo, cada uno con su Event Loop), o quitar trabajo del hilo (caché de la respuesta del catálogo, que es casi idéntica para todos).

### 5.4 Postgres: bloqueos de fila y el `fsync` del COMMIT

Cada venta mantiene bloqueadas sus filas de `productos` desde el `SELECT … FOR UPDATE` hasta que el `COMMIT` termina, y el `COMMIT` no termina hasta que el WAL está en el disco (`fsync`). El tiempo que una fila está bloqueada es aproximadamente:

$$T_{\text{bloqueo}} \approx k\cdot W_{\text{loop}} + T_{\text{sentencias}} + T_{\text{fsync}}$$

Hay un detalle de arquitectura importante: **los viajes por el Event Loop ocurren con la fila bloqueada.** Si el Event Loop está congestionado, la transacción tarda más y retiene el bloqueo más tiempo, y otra venta del mismo producto espera. La congestión de CPU de Node se convierte en contención en Postgres.

Probabilidad de colisión: 261 ventas/s × 2,5 productos ≈ 650 bloqueos de fila por segundo sobre los ≈ 40 productos "calientes" que cada usuario guarda de su catálogo (de 500). Con T_bloqueo ≈ 30 ms en E1, cada fila caliente está bloqueada un 650 / 500 × 0,03 ≈ 4 % del tiempo en promedio, y bastante más en los productos de las primeras páginas. Es poco en E1, pero escala con T_bloqueo: en E2 el `fsync` va por la red a EBS (`w_await` 0,62 ms contra 0,06 ms) y el Event Loop está más lento, así que la contención crece.

¿Y los IOPS? Cada `COMMIT` exige al menos una escritura sincrónica del WAL. Postgres agrupa los `fsync` de transacciones que llegan juntas (*group commit*), por eso 261 ventas/s no son 261 × 10 escrituras. Las 1.240 escrituras/s medidas son el WAL más lo que el *checkpointer* y el *background writer* llevan al disco (páginas de `ventas`, `detalle_ventas`, `movimientos_inventario` y sus índices). Las lecturas son ≈ 2/s: **todo el conjunto de trabajo cabe en la caché** (`shared_buffers` + caché de páginas del SO). Es la localidad temporal de la sesión 6 aplicada a una base de datos.

### 5.5 El throttling del contenedor, en números

Con `--cpus=0.5`, el kernel le da al cgroup **50 ms de CPU por cada ventana de 100 ms** (CFS bandwidth control). La cuota se cuenta **para todos los hilos del proceso juntos**. Si el hilo principal y los 4 hilos de libuv corren a la vez (5 hilos), se gastan los 50 ms en 10 ms de reloj y **el proceso entero queda congelado los 90 ms restantes**, Event Loop incluido.

- `cpu.stat`: `nr_throttled / nr_periods` = 3.402 / 3.600 = **94,5 %** de las ventanas terminaron en congelamiento.
- `throttled_usec` / `nr_throttled` = 161,2 s / 3.402 ≈ **47 ms congelado por ventana** en promedio.
- `docker stats` muestra 49,8 % de CPU: el panel dice "medio núcleo, todo bien", y la latencia está en segundos. Es el caso del contenedor lento con la CPU al 40 % de la sesión 5.

**Cuánto aguanta como máximo.** El costo total de CPU de la API (todos sus hilos) es 1,68 núcleos / 871 req/s ≈ **1,93 ms de CPU por petición**. Con 0,5 núcleos el techo es 0,5 / 0,00193 ≈ **259 req/s**; medimos 238 (92 % del techo). Y el reparto es injusto: los logins son el 10 % de las peticiones, pero con 8,5 ms de CPU cada uno consumen **24 × 8,5 ≈ 204 ms de los 500 ms disponibles por segundo: el 41 % de la cuota.**

**Corrida de control (ILUSTRATIVO):** el mismo contenedor con `API_CPUS=2.0` dio 858 req/s, p99 = 284 ms y 6 % de ventanas con throttling, casi igual que E1. Así queda aislada la variable: **lo que hunde a E3 es el límite de CPU, no Docker.** Un contenedor es un proceso normal del mismo núcleo de Linux, aislado con *namespaces* y limitado con *cgroups* (sesión 10). No hay hipervisor de por medio y su sobrecosto propio es de alrededor de 1 %.

## 6. Comparación justa entre entornos

### 6.1 Tabla comparativa (misma carga, mismas mediciones) **(ILUSTRATIVO)**

| Criterio | E1 · Física local | E2 · t3.micro | E3 · Docker 0,5 vCPU / 512 MB |
|---|---|---|---|
| Caudal sostenido (300 usuarios) | **871 req/s** | 402 req/s | 238 req/s |
| p50 / p95 / p99 global | 24 / 150 / **260 ms** | 310 / 1.020 / **1.480 ms** | 690 / 2.350 / **3.600 ms** |
| ¿Cumple el SLO? | Sí | No | No |
| Componente que limita | Hilo del Event Loop (92 %) | 1 núcleo físico para Node **y** Postgres, `st` = 3,4 % | Cuota CFS (94,5 % de ventanas con throttling) |
| Memoria pico / disponible | 518 MB / 16 GB | ≈ 640 MB / 1 GiB | 176 MiB / 512 MiB (API) |
| IOPS medidos / capacidad | 1.240 / >100.000 | 640 / 3.000 (gp3) | 410 / host |
| Red medida / capacidad | 53 Mb/s / 1 Gb/s | 25 Mb/s / 64 Mb/s de base | 14 Mb/s / host |
| Costo mensual | ≈ USD 33,7 (6.3) | USD 12,84 (standard) · ≈ USD 73 (unlimited sostenido) | ≈ USD 18,02 (Fargate equivalente, solo API) |
| **Costo por millón de peticiones** | **USD 0,015** | USD 0,070 (unlimited) | USD 0,029 |

### 6.2 Qué le sobra y qué le falta a cada uno

**E1 · Máquina física local.**
_Le sobra:_ núcleos (10 de 12 hilos ociosos), RAM (12,9 GB libres), IOPS y red. El NVMe va por PCIe directo al procesador: `w_await` de 0,06 ms, diez veces menos que EBS, y por eso las transacciones retienen menos tiempo los bloqueos. Sus núcleos suben a 4,2 GHz y no hay vecinos (`st` = 0).
_Le falta:_ **un Event Loop más**. El techo no lo pone la máquina sino la parte secuencial del programa. Para producción le faltan cosas que no son de rendimiento: IP pública estable, redundancia eléctrica y de red, y alguien que la administre.

**E2 · t3.micro.**
_Le sobra:_ IOPS (640 de 3.000) y, a esta carga, red.
_Le falta:_ **núcleos físicos**. Sus 2 vCPU son **un solo núcleo con Hyper-Threading**: el Event Loop de Node y los procesos de Postgres compiten por las mismas unidades de ejecución, y el segundo hilo aporta solo entre 15 y 30 % (sesión 5). Además, el reloj es más bajo (≤ 3,1 GHz contra 4,2), la caché L3 se comparte con otros clientes y el hipervisor le quita tiempo (`st` = 3,4 %). Los cambios de contexto involuntarios de `node` suben de 180/s a 1.900/s. Le falta también **RAM**: con 1 GiB quedan ≈ 310 MB disponibles, así que no hay espacio para subir `shared_buffers` ni el pool, y no hay swap. Y lo más grave: **el rendimiento medido no se sostiene** (sección 7).

**E3 · Contenedor 0,5 vCPU / 512 MB.**
_Le sobra:_ memoria (la API usa 176 de 512 MiB) y todo el hardware del host.
_Le falta:_ **cuota de CPU**. La demanda medida es ≈ 1,7 núcleos y el límite es 0,5. El throttling del CFS congela todo el proceso, Event Loop incluido, en casi todas las ventanas de 100 ms, y la latencia salta en escalones de decenas de milisegundos. Es el entorno donde más se nota que **el límite no reduce la velocidad: reparte el tiempo**.

### 6.3 Cómo se calculó el costo por unidad de trabajo

La sesión 10 pide comparar por **costo por unidad de trabajo**. Usamos 730 h/mes = 2.628.000 s.

- **E1:** amortización del equipo: _[ILUSTRATIVO: USD 800 / 36 meses = 22,22]_; energía: 75 W × 730 h = 54,75 kWh × _[tarifa Cedenar estrato X ≈ USD 0,21/kWh]_ = 11,50. **Total ≈ USD 33,72/mes.** Peticiones/mes = 871 × 2.628.000 = 2.289 millones → **USD 0,0147 por millón.**
- **E2 (unlimited, sostenido):** 7,59 + 1,60 + 3,65 + 60,60 de créditos excedentes (sección 7) = **USD 73,44/mes**; 402 × 2.628.000 = 1.056 millones → **USD 0,0695 por millón**, y aun así no cumple el SLO.
- **E3:** precio de referencia de un contenedor administrado de la misma forma (AWS Fargate, us-east-1: USD 0,04048 por vCPU-h y USD 0,004445 por GB-h; 0,5 vCPU exige mínimo 1 GB): 0,5 × 0,04048 + 1 × 0,004445 = 0,0247 USD/h → **USD 18,02/mes**; 238 × 2.628.000 = 625 millones → **USD 0,0288 por millón** (solo la API; la base de datos iría aparte).

> Verifiquen estos precios de lista en la calculadora oficial antes de entregar y anoten la fecha de consulta.

## 7. La prueba larga: los créditos de la t3.micro **(ILUSTRATIVO)**

La rúbrica pide "carga sostenida, no ráfagas", y la t3.micro es el caso donde la diferencia se ve. Corrimos 30 minutos en modo **standard** y graficamos `CPUCreditBalance` en CloudWatch:

| Minuto | Saldo de créditos | CPU (CloudWatch) | Caudal | p99 |
|---|---|---|---|---|
| 0 | 34,0 | 93 % | 402 req/s | 1.480 ms |
| 10 | 17,4 | 93 % | 398 req/s | 1.510 ms |
| 20 | 0,8 | 93 % | 395 req/s | 1.560 ms |
| 21 | 0,0 | **20 %** (línea base) | **43 req/s** | **> 9.000 ms** |
| 30 | 0,0 | 20 % | 41 req/s | > 9.000 ms, 7,8 % de errores por *timeout* de 30 s |

**La cuenta:** 1 crédito = 1 vCPU al 100 % durante 1 minuto. La instancia usa 0,93 × 2 = 1,86 vCPU → gasta 1,86 créditos/min y gana 12/h = 0,2/min. Pierde **1,66 créditos por minuto**: 34 / 1,66 ≈ **20,5 minutos**. Después queda limitada a su línea base de 10 % por vCPU (0,2 vCPU en total), y el caudal cae a 0,2 / 1,86 ≈ 11 % del inicial. Es exactamente el caso de la sesión 5: _"funciona perfecto en la demo y en producción se cae a los veinte minutos"_. Una prueba de 5 minutos no lo habría mostrado.

En modo **unlimited** (el predeterminado de t3) el rendimiento no cae, pero AWS cobra el excedente a USD 0,05 por vCPU-hora: 1,66 vCPU × 0,05 × 730 h ≈ **USD 60,6 adicionales al mes**. La instancia "de 10 dólares" cuesta en realidad unos 73 dólares al mes con esta carga sostenida, y aun así no cumple el SLO.

## 8. Si la carga se multiplicara por diez

Con 3.000 usuarios, la demanda sería del orden de 8.700 req/s. En orden de ruptura:

1. **Primero se rompe el hilo del Event Loop (CPU, un núcleo).** ρ ya está en 0,92. Con 10 veces más demanda harían falta 9,2 núcleos de JavaScript secuencial: imposible. ρ ≥ 1 significa que la cola crece sin límite. En un sistema real de lazo abierto (los clientes no esperan para mandar la siguiente petición), las peticiones pendientes se acumulan en memoria (sockets, buffers, cierres de JavaScript) y el RSS sube. **En E3 eso termina en un OOM-kill** (`memory.max` = 512 MB, código de salida 137). En E2, con 1 GiB y sin swap, el *OOM killer* del kernel mata al proceso más grande, que puede ser el de Postgres.
2. **Después, el pool de Postgres (contención).** Ley de Little: 2.610 ventas/s × ≈ 8 ms con conexión tomada ≈ 21 conexiones ocupadas en promedio, más de las 20 del pool. `waitingCount` crece sin techo. Subir el pool tiene un costo: Postgres crea **un proceso por conexión** (≈ 10 MB cada uno) y más conexiones significan más competencia por los mismos bloqueos de fila.
3. **Luego, el disco en la nube (IOPS) y la red de la t3.** ≈ 2.600 `COMMIT`/s, con *group commit*, se acercan a los 3.000 IOPS de línea base de gp3, y `w_await` (ya en 0,62 ms por ir por la red) alarga cada bloqueo. El catálogo a 10× serían ≈ 66 MB/s ≈ 530 Mb/s, **8 veces la línea base de red de la t3.micro** (≈ 64 Mb/s): se gastan los créditos de red y la red pasa a ser el cuello de botella. En E1 el NVMe y la red de 1 Gb/s todavía aguantarían.

**Respuesta corta:** se rompe primero la CPU, pero solo un núcleo, el del Event Loop. Le siguen el pool de conexiones y los bloqueos de fila, y en la nube después el disco EBS y la red base de la instancia.

## 9. Recomendación

**Descartamos:**

- **E3 (contenedor 0,5 vCPU).** La aplicación demanda ≈ 1,7 núcleos medidos. Con 0,5 el CFS la congela en el 94,5 % de las ventanas y el p99 llega a 3,6 s. No es un problema de Docker: con 2,0 vCPU, el mismo contenedor iguala a la máquina física.
- **E2 (t3.micro).** Un solo núcleo físico compartido por Node y Postgres no alcanza ni con créditos (p99 = 1,48 s). Sin créditos, el caudal cae al 11 % a los 20 minutos. En modo unlimited cuesta ≈ USD 73/mes y sigue sin cumplir. Además, 1 GiB no deja margen.
- **E1 como servidor de producción.** Es la única que cumple el SLO, pero no ofrece disponibilidad, IP pública ni respaldo. Nos sirve como techo de referencia.

**Recomendamos:** una máquina con **al menos 2 núcleos físicos reales y sin modelo de créditos**, con la API en contenedor limitado a `cpus=2.0` y 512 MB (validado en la corrida de control: 858 req/s, p99 = 284 ms). Una opción concreta en AWS es **c7g.large** (2 vCPU Graviton3, ARM, **cada vCPU es un núcleo físico** porque Graviton no usa SMT; 4 GiB; USD 0,0725/h ≈ USD 52,93/mes + EBS + IPv4 ≈ **USD 58/mes**). Postgres cabe en la misma instancia con `shared_buffers` en 1 GB. Requiere construir la imagen para `linux/arm64` (`docker buildx build --platform linux/amd64,linux/arm64`), lo que conecta con la sesión 9 sobre el ISA. **Antes de comprarla hay que repetir la medición en ella:** la recomendación sale de nuestros datos, pero no la hemos medido.

**Y, más barato que cualquier máquina:** sacar del Event Loop el trabajo que se repite (cachear la respuesta del catálogo por categoría unos segundos, que es casi idéntica para todos) y correr 2 procesos de Node con `node:cluster`. Las dos medidas atacan directamente la parte secuencial que fija el techo según Amdahl.

## 10. Limitaciones y amenazas a la validez

- Locust en Python tiene su propio techo de CPU. Verificamos que la máquina generadora no pasara de 80 % de CPU. Si pasa, hay que usar `--processes` o varios *workers*.
- La carga es de lazo cerrado. Los usuarios reales no esperan a que el servidor responda para llegar, así que en producción la degradación sería peor que la medida.
- El conjunto de datos (500 productos) cabe completo en caché. Con un catálogo de millones de filas aparecerían lecturas de disco y el diagnóstico podría cambiar.
- En la nube, el vecino ruidoso varía con la hora (`st`). Las tres corridas en E2 se hicieron en horarios distintos.

## 11. Reproducibilidad

```
trabajo_final_arquitectura_computacional/
├── base_de_datos.sql          esquema + seed (2 usuarios, 6 categorías, 500 productos)
├── script_carga_locust.py     carga sostenida 10/60/30, ≥ 5 min, CSV + métricas internas
├── medir_recursos.sh          vmstat, mpstat, pidstat, iostat, sar, docker stats, cpu.stat
├── informe_tecnico.md         este documento
├── guion_diapositivas.md      guion de la sustentación de 7 minutos
├── resultados/
│   ├── validacion_vm_desarrollo/   corrida real del Anexo A (ejemplo del formato)
│   └── <entorno>_corrida<N>/       ← AGREGAR: datos crudos de 3 corridas × 3 entornos
└── proyecto/
    ├── docker-compose.yml     entorno E3 (API 0,5 vCPU / 512 MB, BD 1 vCPU / 512 MB)
    ├── backend/               Express + TypeScript (+ Dockerfile)
    └── frontend/              React + Vite + TypeScript
```

Puesta en marcha mínima:

```bash
# Base de datos
createdb tienda_carga && psql -d tienda_carga -f base_de_datos.sql
# API
cd proyecto/backend && npm ci && npm run build && JWT_SECRET=... node dist/server.js
# Frontend (opcional, para la demo)
cd proyecto/frontend && npm ci && npm run dev        # http://localhost:5173
# Entorno contenedor
cd proyecto && docker compose up -d --build          # API_CPUS=2.0 para la corrida de control
```

Credenciales de prueba: `vendedor@tienda.local / Vendedor2026*` y `admin@tienda.local / Admin2026*`.

---

## Anexo A · Corrida real de validación de los guiones

Estos datos **sí son medidos**, no simulados. Los tomamos el 11 de noviembre de 2026 para comprobar que `script_carga_locust.py` y `medir_recursos.sh` funcionan de punta a punta. Los archivos crudos están en `resultados/validacion_vm_desarrollo/`. **No son ninguno de los tres entornos del proyecto**: fue una máquina virtual de desarrollo en la nube con 4 vCPU Intel Xeon a 2,1 GHz (1 hilo por núcleo), 16 GB de RAM y Ubuntu 24.04, con Node.js 22, PostgreSQL 16 y **Locust corriendo en la misma máquina**. Ese último punto es justo lo que la metodología de la sección 3.1 prohíbe, y se nota en los resultados.

**Carga:** 300 usuarios, 60 s de rampa y 300 s sostenidos. Mezcla obtenida: 28.288 logins (10,0 %), 169.755 consultas de catálogo (59,9 %) y 85.119 ventas (30,0 %). **0 fallos** en 283.462 peticiones.

| Endpoint | req/s | p50 | p95 | p99 | máx |
|---|---|---|---|---|---|
| Login | 78,5 | 63 ms | 140 ms | 200 ms | 357 ms |
| Catálogo | 470,9 | 27 ms | 73 ms | 100 ms | 233 ms |
| Venta | 236,1 | 63 ms | 130 ms | 170 ms | 335 ms |
| **Total** | **786,4** | **37 ms** | **110 ms** | **150 ms** | 357 ms |

| Métrica (290 s de meseta) | Valor medido | Fuente |
|---|---|---|
| CPU global `us / sy / wa / id / st` | 76,4 / 7,1 / 0,9 / 15,0 / 1,1 | `vmstat 1` |
| CPU proceso `node` | 157,6 % | `pidstat -u` |
| — hilo principal | 61,3 % de `%CPU` **y 31,3 % de `%wait`** | `pidstat -t` |
| — 4 hilos libuv (scrypt) | 4 × 23,5 % (y ≈ 20 % de `%wait` cada uno) | `pidstat -t` |
| CPU de Postgres (suma de procesos) | ≈ 94 % | `pidstat -u` |
| Memoria residente `node` | 170–174 MB | `pidstat -r` y `/api/metricas` |
| Retraso del Event Loop p50 / p95 / p99 | 1,1 / 6,2 / 9,8 ms | `/api/metricas` |
| Cola del pool de Postgres (`waitingCount`) | promedio 9,9, máximo 76 | `/api/metricas` |
| Disco `r/s`, `w/s`, `wkB/s`, `w_await`, `%util` | 0,1 / 725 / 4.410 / 0,16 ms / 10,5 % | `iostat -x 1` |
| Red (interfaz `lo`, porque Locust era local) | 12,2 MB/s en cada sentido | `sar -n DEV 1` |
| Cambios de contexto `node` voluntarios / involuntarios | 193 /s / 827 /s | `pidstat -w` |
| Integridad: unidades vendidas = kárdex = stock descontado | Sí, en la corrida previa de 30.200 ventas | consulta SQL de verificación |

**Lectura con el método del curso:**

1. **No es disco.** `wa` = 0,9 %, `%util` = 10,5 %, `r/s` ≈ 0: el conjunto de trabajo está en caché. 725 escrituras/s con solo 4,4 MB/s confirman que una base transaccional pide IOPS y no caudal.
2. **Es CPU, pero distinta a la de E1.** Aquí la máquina entera está saturada (`id` = 15 %), porque 4 vCPU se reparten entre Node, Postgres y el propio Locust. La prueba es la columna **`%wait` de `pidstat -t`**: el hilo del Event Loop pasó el 31 % del tiempo **listo para correr pero esperando un núcleo libre** en la cola del planificador. Es el efecto de no separar el generador de carga del servidor.
3. **El scrypt pesa mucho.** Los 4 hilos de libuv suman ≈ 94 % de un núcleo para atender el 10 % de las peticiones (logins). En una máquina con pocos núcleos, el login es el mayor consumidor de CPU de la API.
4. **Hay contención en el pool.** La cola de espera por una conexión de Postgres promedió 9,9 peticiones. Con las ventas reteniendo conexiones durante 10 sentencias, el pool de 20 es el siguiente límite, como predice la sección 8.

Moraleja metodológica: si Locust corre en la misma máquina, el resultado mide a los dos juntos. Por eso en los entornos del proyecto la carga se genera desde otra máquina.

