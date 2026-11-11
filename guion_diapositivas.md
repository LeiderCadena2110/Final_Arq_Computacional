# Guion de sustentación · 7 minutos + 3 de preguntas

**Proyecto final · Arquitectura Computacional · UCC Pasto**
**Tema:** ¿Dónde espera nuestra API de ventas, y en qué máquina debería correr?

> **Antes de ensayar:** los números de este guion son los del borrador del informe (marcados ILUSTRATIVO). Cámbienlos por los suyos. Si sus datos dicen otra cosa, cambien la conclusión, no los datos. El docente pregunta siempre lo mismo: **¿qué número lo demuestra y qué componente lo causa?**

---

## Reparto del tiempo

| Min | Diapositiva | Quién | Idea que tiene que quedar |
|---|---|---|---|
| 0:00–0:40 | 1. La pregunta | Integrante 1 | "¿En qué máquina debería correr esta app y con qué datos lo sostenemos?" |
| 0:40–1:30 | 2. La aplicación y la carga | Integrante 1 | Tres operaciones, cada una estresa un componente distinto |
| 1:30–2:30 | 3. Cómo medimos | Integrante 2 | 5 minutos sostenidos, 3 repeticiones, percentiles, comandos del SO |
| 2:30–3:50 | 4. Dónde espera: el número | Integrante 2 | Un núcleo al 92 % mientras el resto descansa |
| 3:50–4:50 | 5. El porqué con arquitectura | Integrante 1 | Cola de un servidor, Amdahl, bloqueos + fsync |
| 4:50–6:00 | 6. Los tres entornos | Integrante 2 | Tabla justa + throttling CFS + créditos t3 |
| 6:00–6:40 | 7. ×10 y recomendación | Integrante 1 | Qué se rompe primero y qué compraríamos |
| 6:40–7:00 | 8. Cierre | Integrante 2 | Una frase |

---

## Diapositiva 1 · La pregunta (0:40)

**En pantalla:** la pregunta grande. Debajo: _"Respuesta corta: espera por CPU, pero solo por UN núcleo."_

**Decir:**
> "Nuestra aplicación es una API de ventas en Node.js con PostgreSQL. La pregunta del curso es en qué máquina debería correr. La respuesta corta, que vamos a demostrar con números, es que la aplicación espera por CPU, y no por la CPU en general: por un solo núcleo, el del Event Loop de Node. Eso explica todo lo demás que vamos a mostrar."

## Diapositiva 2 · La aplicación y la carga (0:50)

**En pantalla:** tabla de 3 filas.

| Operación | % | Componente que estresa |
|---|---|---|
| Login (scrypt) | 10 % | CPU en el pool de hilos de libuv |
| Catálogo | 60 % | CPU del hilo principal + red (12 KB/respuesta) |
| Venta (BEGIN…COMMIT, 10 sentencias) | 30 % | Disco (fsync del WAL) + bloqueos de fila |

**Decir:**
> "Diseñamos la mezcla para que cada componente tuviera la oportunidad de ser el cuello de botella. El login gasta CPU en scrypt. El catálogo gasta CPU serializando JSON y gasta red. La venta abre una transacción explícita que bloquea filas con FOR UPDATE y no termina hasta que el WAL se escribe en disco con fsync."

## Diapositiva 3 · Cómo medimos (1:00)

**En pantalla:** el perfil de carga (rampa de 60 s y meseta de 300 s) y la lista de comandos.

```
Locust: 300 usuarios · 60 s de rampa · 300 s sostenidos · 3 repeticiones · mediana
vmstat 1     → us / sy / wa / id / st
pidstat -t   → CPU por HILO del proceso node
iostat -x 1  → w/s, w_await, %util
sar -n DEV 1 → kB/s de la interfaz
docker stats + cpu.stat → throttling
CloudWatch   → CPUCreditBalance
```

**Decir:**
> "Evitamos los cuatro errores de la sesión 10. No medimos en reposo, medimos tres veces y reportamos la mediana, reportamos p50, p95 y p99 y no el promedio, y sostuvimos la carga cinco minutos, y treinta en la nube. Locust corre en otra máquina para no robarle CPU al servidor. Todos los datos crudos y los guiones están en la entrega."

## Diapositiva 4 · Dónde espera: el número (1:20)

**En pantalla:** dos capturas lado a lado.
- Izquierda, `vmstat`: **us 19 % · wa 0,9 % · id 75 %**
- Derecha, `pidstat -t`: **hilo principal node: 92 %** · 4 hilos libuv: 17 % cada uno

**Decir:**
> "Si miráramos solo vmstat diríamos que sobra CPU: está 75 % ociosa. Pero pidstat por hilo muestra que el hilo principal de Node está al 92 %. Node ejecuta todo el JavaScript en un solo hilo, así que puede saturar un núcleo mientras los otros once hilos de hardware no hacen nada.
> Descartamos los otros sospechosos con números: wa en 0,9 % y el disco al 14 % de utilización, así que no es disco. La red va a 53 de 1.000 megabits, así que no es red. Es CPU porque el hilo principal está en 92 % con wa en 0,9 %."

## Diapositiva 5 · El porqué con arquitectura (1:00)

**En pantalla:** la curva W = S·ρ/(1−ρ) con el punto ρ = 0,92 marcado, y la cuenta de Amdahl.

**Decir:**
> "El Event Loop se comporta como una cola con un solo servidor. Sumando lo que cuesta cada petición en el hilo principal por su tasa da ρ igual a 0,92, que coincide con el 92 % de pidstat. En una cola así, la espera crece como ρ sobre uno menos ρ: con 0,92 se multiplica por 11,5. Esa espera la medimos dentro del proceso: es el retraso del Event Loop, con p99 de 39 ms.
> Las ventas sufren más porque pasan once veces por esa cola, una por cada respuesta de Postgres, y lo hacen con las filas bloqueadas. Así la congestión de CPU de Node se convierte en contención en Postgres.
> Y por Amdahl, solo el 43 % del trabajo es paralelo, así que el máximo es 1,75 veces aunque compremos 64 núcleos."

## Diapositiva 6 · Los tres entornos (1:10)

**En pantalla:** la tabla comparativa con los tres p99 en grande: **260 ms · 1.480 ms · 3.600 ms**, y el costo por millón de peticiones.

**Decir:**
> "Misma carga y mismas mediciones en los tres. La máquina física cumple, con p99 de 260 ms.
> La t3.micro no cumple. Sus dos vCPU son un solo núcleo físico con Hyper-Threading, y ahí compiten Node y Postgres. A eso se suma un 3,4 % de steal del hipervisor. Y en la prueba de 30 minutos se acabaron los créditos al minuto 21 y el caudal cayó al 11 %.
> El contenedor de medio vCPU es el peor. cpu.stat muestra que el 94,5 % de las ventanas de 100 ms terminaron congeladas. Docker stats dice 50 % de CPU, que parece normal, y la latencia está en segundos. Con 2 vCPU, el mismo contenedor iguala a la máquina física, así que el problema es el límite, no Docker."

## Diapositiva 7 · ×10 y recomendación (0:40)

**En pantalla:** tres pasos numerados: **1. Event Loop → 2. Pool de 20 conexiones y bloqueos → 3. IOPS de EBS y red base de la t3.** Debajo: **Recomendación: 2 núcleos físicos sin créditos (c7g.large ≈ USD 58/mes) + caché del catálogo + 2 procesos de Node.**

**Decir:**
> "Con diez veces la carga se rompe primero el Event Loop: necesitaría 9 núcleos de un programa que solo usa uno. Después el pool de conexiones, por la ley de Little: más de 20 conexiones ocupadas en promedio. Y en la nube, después, los IOPS de EBS y la red base de la t3.
> Recomendamos una máquina con dos núcleos físicos reales y sin créditos, por ejemplo una c7g.large. Pero lo más barato es cambiar el programa: cachear el catálogo y correr dos procesos de Node."

## Diapositiva 8 · Cierre (0:20)

**En pantalla:** _"No compramos más máquina hasta saber qué está esperando."_

**Decir:**
> "Lo que aprendimos es que el 75 % de CPU ociosa estaba escondiendo un núcleo al 92 %. Sin medir por hilo, habríamos comprado la máquina equivocada. Gracias."

---

# Preguntas del docente: respuestas preparadas

Respondan en este orden: **número → cómo se midió → componente que lo causa**. Máximo 40 segundos por respuesta.

### P1. ¿Por qué ese número de latencia o de CPU, y cómo lo midieron con el sistema operativo?

> "El p99 de 260 ms lo da Locust, que guarda el tiempo de cada petición y calcula los percentiles sobre las 260.000 peticiones de la meseta. Es la mediana de tres corridas que variaron menos del 5 %.
> El 92 % de CPU lo da `pidstat -t -u -p <pid> 5`, que lee `/proc/<pid>/task/<tid>/stat` del kernel y muestra la CPU de cada hilo del proceso. Lo confirmamos de dos formas independientes: sumando λ·S por endpoint da ρ = 0,92, y el histograma de `monitorEventLoopDelay` de Node da un retraso p99 de 39 ms.
> ¿Por qué ese número y no otro? Porque la latencia sale de la cola del Event Loop. Con ρ = 0,92, la espera es 11,5 veces el tiempo de servicio, y la venta pasa 11 veces por esa cola. Por eso la venta tiene p50 de 64 ms y el catálogo de 17 ms, aunque Postgres resuelva las dos en pocos milisegundos."

_Si repregunta "¿por qué no el promedio?":_
> "Porque el promedio de 44 ms esconde que una de cada cien peticiones tarda 260. El usuario siente la cola de la distribución, no el promedio."

### P2. ¿Qué componente físico o del kernel de Linux está causando ese comportamiento?

> "Son tres, uno por entorno.
> En todos: **un núcleo de CPU**, porque el JavaScript de Node se ejecuta en un solo hilo del sistema operativo. El planificador del kernel le puede dar un núcleo entero, pero nunca dos.
> En el contenedor: el **CFS bandwidth control de cgroups v2**. `cpu.max = 50000 100000` da 50 ms de CPU cada 100 ms para todos los hilos juntos. Cuando los 4 hilos de libuv calculan scrypt al mismo tiempo que el hilo principal, la cuota se acaba en unos 10 ms y el kernel congela todo el proceso hasta la siguiente ventana. Lo vimos en `cpu.stat`: `nr_throttled` en 94,5 % de los periodos.
> En la t3.micro: el **Hyper-Threading**, porque dos vCPU son un núcleo físico con dos juegos de registros y una sola ALU que comparten Node y Postgres. Además, el **hipervisor** de AWS le quita tiempo, que se ve como `st` en `vmstat`, y el **sistema de créditos** la baja al 10 % por vCPU cuando se le acaban.
> En Postgres, el `fsync` del WAL obliga a que el disco confirme antes del `COMMIT`. En EBS ese viaje va por la red, con `w_await` de 0,62 ms contra 0,06 ms del NVMe, que va directo por PCIe. Eso alarga el tiempo que las filas quedan bloqueadas."

### P3. Si la carga se multiplicara por diez, ¿qué componente de hardware o software se rompería primero?

> "Primero el **hilo del Event Loop**. Hoy está en ρ = 0,92. Diez veces más demanda pediría 9,2 núcleos de trabajo secuencial, y como ρ no puede pasar de 1, la cola crece sin límite. Las peticiones pendientes se acumulan en memoria y el proceso crece hasta que, en el contenedor de 512 MB, el kernel lo mata por OOM con código 137.
> Segundo, el **pool de 20 conexiones**. Por la ley de Little, 2.600 ventas por segundo por 8 ms cada una da más de 20 conexiones ocupadas en promedio. Subirlo no es gratis: Postgres usa un proceso por conexión, de unos 10 MB cada uno, y habría más competencia por los mismos bloqueos.
> Tercero, en la nube: los **3.000 IOPS de línea base de gp3** por los `COMMIT`, y la **red base de la t3.micro**, de unos 64 Mb/s, que el catálogo superaría ocho veces.
> No sería el disco local: el NVMe está al 14 %."

### P4. ¿Qué opción de entorno descartaron y cuál recomiendan, justificándolo con arquitectura?

> "Descartamos el **contenedor de 0,5 vCPU**. La demanda medida es de 1,7 núcleos y el límite es 0,5, así que el CFS lo congela en casi todas las ventanas: p99 de 3,6 segundos. Docker no es el problema: con 2 vCPU iguala a la máquina física.
> Descartamos la **t3.micro**. Un solo núcleo físico compartido por Node y Postgres no cumple ni con créditos, y sin créditos se cae al 11 % a los 20 minutos. En modo unlimited cuesta unos 73 dólares al mes y sigue sin cumplir.
> La **máquina física** cumple, pero no sirve como producción: no tiene IP pública, redundancia ni respaldo.
> Recomendamos **dos núcleos físicos reales y sin créditos**, por ejemplo una c7g.large con Graviton, donde cada vCPU es un núcleo porque no tiene SMT, por unos 58 dólares al mes. Esto sale de nuestros datos: 1,7 núcleos de demanda y Amdahl con techo de 1,75 veces. Habría que confirmarlo midiendo en esa instancia, y construir la imagen para ARM.
> Y antes de pagar más, cambiaríamos el programa: cachear la respuesta del catálogo y correr dos procesos de Node con cluster. Eso ataca la parte secuencial que pone el techo."

---

## Repreguntas probables (respuesta de una línea)

| Si pregunta… | Respondan |
|---|---|
| "¿Por qué no usaron el promedio de CPU de `top`?" | "Porque promedia 12 hilos de hardware. El 19 % global esconde un hilo al 92 %. Por eso medimos por hilo con `pidstat -t`." |
| "¿Qué es `wa`?" | "Tiempo en que la CPU está ociosa con E/S de disco pendiente. Si está alto, la CPU espera al disco. Nosotros tenemos 0,9 %." |
| "¿Qué es `st`?" | "Steal: tiempo en que la vCPU quería correr y el hipervisor se la dio a otra máquina virtual. En la t3 fue 3,4 %." |
| "¿El JWT es cifrado?" | "No, es firmado. Verificarlo es recalcular un HMAC-SHA256, unos 40 µs por petición en el hilo principal. Lo caro es el scrypt del login, que va al pool de libuv." |
| "¿Por qué scrypt y no bcrypt?" | "Viene en el módulo `crypto` de Node y su versión asíncrona corre en el pool de libuv, no en el Event Loop. Así vimos el costo en hilos aparte con `pidstat -t`." |
| "¿Por qué IOPS y no MB/s?" | "Porque una base transaccional hace muchas escrituras pequeñas: 1.240 escrituras por segundo con solo 9,8 MB/s. Lo que importa es cuántas operaciones, no cuántos bytes (sesión 7)." |
| "¿Por qué casi no hay lecturas de disco?" | "Porque los 500 productos y sus índices caben en `shared_buffers` y en la caché de páginas del SO. Es localidad temporal: el dato se vuelve a usar y se queda en RAM." |
| "¿Contenedor o máquina virtual?" | "Un contenedor es un proceso del mismo núcleo, aislado con namespaces y limitado con cgroups. No hay hipervisor, por eso su sobrecosto es de alrededor de 1 % y arranca en milisegundos." |
| "¿Por qué ordenan los productos por id en el FOR UPDATE?" | "Para que dos ventas concurrentes siempre bloqueen en el mismo orden y no se crucen. Si igual pasa, Postgres lanza 40P01 y la transacción se reintenta." |
| "¿Cuánto cuesta atender un millón de peticiones?" | "1,5 centavos de dólar en la física, 2,9 en el contenedor de referencia y 7 en la t3 unlimited. Es la métrica justa para comparar máquinas distintas (sesión 10)." |

---

## Lista de verificación el día de la sustentación

- [ ] Reemplazar todos los números ILUSTRATIVOS por los suyos (informe y este guion).
- [ ] Llevar abiertas las capturas de `pidstat -t`, `vmstat`, `iostat -x` y `cpu.stat`. Son la evidencia.
- [ ] Llevar la gráfica de `CPUCreditBalance` de CloudWatch.
- [ ] Ensayar con cronómetro: 7:00 exactos. Si sobra tiempo, no rellenar.
- [ ] Ambos integrantes deben poder responder las 4 preguntas. El docente escoge a quién pregunta.
