/**
 * Punto de entrada de la API.
 *
 * Node.js ejecuta el código JavaScript en UN solo hilo (el Event Loop). Todo
 * lo síncrono —parsear JSON, verificar el JWT, armar y serializar respuestas—
 * se hace en serie en ese hilo. La E/S (red, Postgres) es asíncrona y no lo
 * bloquea. Por eso este servidor puede atender cientos de peticiones
 * concurrentes con un solo núcleo, pero no puede usar más de un núcleo para
 * su trabajo de CPU (Amdahl: esa parte es 100 % secuencial).
 *
 * El endpoint /api/metricas expone, en vivo, el retraso del Event Loop
 * (cuánto tarda una tarea lista en empezar a ejecutarse), la memoria
 * residente (RSS), el uso de CPU del proceso y el estado del pool de Postgres.
 * Es la evidencia "desde dentro" que complementa a pidstat/iostat "desde fuera".
 */
import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import { cerrarPool, configuracionBD, estadoPool, verificarConexion } from "./config/database";
import { ErrorHttp } from "./modules/auth/auth.controller";
import authRoutes from "./modules/auth/auth.routes";
import productosRoutes from "./modules/productos/productos.routes";
import ventasRoutes from "./modules/ventas/ventas.routes";

const PUERTO = Number.parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const ORIGEN_CORS = process.env.CORS_ORIGIN ?? "*";
const REGISTRAR_PETICIONES = process.env.LOG_REQUESTS === "1";

const app = express();
app.disable("x-powered-by");
app.set("etag", false); // sin ETag: cada respuesta de catálogo viaja completa, como en la prueba
app.use(cors({ origin: ORIGEN_CORS === "*" ? true : ORIGEN_CORS.split(",") }));
app.use(express.json({ limit: "256kb" }));

// -----------------------------------------------------------------------------
//  Instrumentación
// -----------------------------------------------------------------------------
// El histograma mide el intervalo real entre "ticks" de un temporizador de
// RESOLUCION_MS; el retraso del Event Loop es ese intervalo menos la resolución.
const RESOLUCION_MS = 10;
const retrasoLoop = monitorEventLoopDelay({ resolution: RESOLUCION_MS });
retrasoLoop.enable();

const contadores = {
  peticiones: 0,
  errores4xx: 0,
  errores5xx: 0,
  enCurso: 0,
  inicio: Date.now(),
};

let cpuAnterior = process.cpuUsage();
let instanteAnterior = process.hrtime.bigint();

app.use((req: Request, res: Response, next: NextFunction) => {
  const t0 = process.hrtime.bigint();
  contadores.peticiones += 1;
  contadores.enCurso += 1;
  res.on("finish", () => {
    contadores.enCurso -= 1;
    if (res.statusCode >= 500) contadores.errores5xx += 1;
    else if (res.statusCode >= 400) contadores.errores4xx += 1;
    if (REGISTRAR_PETICIONES) {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)} ms`);
    }
  });
  next();
});

// -----------------------------------------------------------------------------
//  Rutas
// -----------------------------------------------------------------------------
app.get("/api/health", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const bd = await verificarConexion();
    res.json({ estado: "ok", bd: bd.ok ? "ok" : "sin respuesta", pid: process.pid, uptimeSegundos: Math.round(process.uptime()) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/metricas", (_req: Request, res: Response) => {
  const ahora = process.hrtime.bigint();
  const cpu = process.cpuUsage(cpuAnterior);
  const transcurridoUs = Number(ahora - instanteAnterior) / 1000;
  cpuAnterior = process.cpuUsage();
  instanteAnterior = ahora;

  const memoria = process.memoryUsage();
  const retraso = (ns: number): number => Math.max(0, Math.round((ns / 1e6 - RESOLUCION_MS) * 100) / 100);
  const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

  res.json({
    pid: process.pid,
    uptimeSegundos: Math.round(process.uptime()),
    // % de UN núcleo desde la última consulta (puede pasar de 100 % por los hilos de libuv)
    cpuProcesoPorcentaje: transcurridoUs > 0 ? Math.round(((cpu.user + cpu.system) / transcurridoUs) * 1000) / 10 : 0,
    cpuUsuarioMs: Math.round(cpu.user / 1000),
    cpuSistemaMs: Math.round(cpu.system / 1000),
    memoriaMB: {
      rss: mb(memoria.rss),
      heapUsado: mb(memoria.heapUsed),
      heapTotal: mb(memoria.heapTotal),
      externa: mb(memoria.external),
      buffers: mb(memoria.arrayBuffers),
    },
    eventLoopRetrasoMs: {
      min: retraso(retrasoLoop.min),
      p50: retraso(retrasoLoop.percentile(50)),
      p95: retraso(retrasoLoop.percentile(95)),
      p99: retraso(retrasoLoop.percentile(99)),
      max: retraso(retrasoLoop.max),
      media: retraso(retrasoLoop.mean),
    },
    pool: estadoPool(),
    peticiones: { ...contadores, inicio: new Date(contadores.inicio).toISOString() },
    sistema: {
      cpusVisibles: os.cpus().length,
      paralelismoDisponible: typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
      carga1m: os.loadavg()[0],
      memoriaLibreMB: mb(os.freemem()),
      memoriaTotalMB: mb(os.totalmem()),
      uvThreadpool: process.env.UV_THREADPOOL_SIZE ?? "4 (por defecto)",
    },
  });
  // Cada consulta abre una nueva ventana de medición del Event Loop.
  retrasoLoop.reset();
});

app.use("/api/auth", authRoutes);
app.use("/api/productos", productosRoutes);
app.use("/api/ventas", ventasRoutes);

app.use((req: Request, _res: Response, next: NextFunction) => {
  next(new ErrorHttp(404, `Ruta no encontrada: ${req.method} ${req.originalUrl}`));
});

// -----------------------------------------------------------------------------
//  Manejo central de errores
// -----------------------------------------------------------------------------
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof ErrorHttp) {
    res.status(error.estado).json({ error: error.message, detalle: error.detalle });
    return;
  }
  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({ error: "JSON mal formado" });
    return;
  }
  const codigo = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (codigo === "23514") {
    // check_violation: el CHECK stock >= 0 detuvo una venta (carrera perdida)
    res.status(409).json({ error: "Stock insuficiente (restricción de la base de datos)" });
    return;
  }
  console.error("[api] Error no controlado:", error);
  res.status(500).json({ error: "Error interno del servidor" });
});

// -----------------------------------------------------------------------------
//  Arranque y apagado ordenado
// -----------------------------------------------------------------------------
async function iniciar(): Promise<void> {
  try {
    const bd = await verificarConexion();
    console.log(`[bd] Conectado a ${configuracionBD.host}:${configuracionBD.port}/${configuracionBD.database} (pool máx. ${configuracionBD.max})`);
    console.log(`[bd] ${bd.version}`);
  } catch (error) {
    console.error("[bd] No se pudo conectar a PostgreSQL:", (error as Error).message);
    process.exit(1);
  }

  const servidor = app.listen(PUERTO, HOST, () => {
    console.log(`[api] Escuchando en http://${HOST}:${PUERTO}  (pid ${process.pid}, ${os.cpus().length} CPUs visibles)`);
  });
  // Conexiones keep-alive más largas que las del balanceador/cliente evitan
  // cierres a mitad de petición bajo carga.
  servidor.keepAliveTimeout = 65_000;
  servidor.headersTimeout = 66_000;

  const apagar = (senal: string): void => {
    console.log(`[api] ${senal} recibido: cerrando…`);
    servidor.close(() => {
      cerrarPool()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", () => apagar("SIGINT"));
  process.on("SIGTERM", () => apagar("SIGTERM"));
}

void iniciar();

export default app;
