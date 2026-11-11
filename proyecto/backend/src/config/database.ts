/**
 * Configuración de la conexión a PostgreSQL.
 *
 * Se usa un pool de conexiones: abrir una conexión TCP + autenticación con
 * Postgres cuesta varios milisegundos y un proceso nuevo del lado del
 * servidor (Postgres crea un proceso por conexión). Reutilizarlas evita
 * pagar ese costo en cada petición.
 *
 * El tamaño del pool (PG_POOL_MAX) es un parámetro de arquitectura que hay
 * que anotar en el informe: es el número máximo de transacciones que la API
 * puede tener abiertas a la vez. Si llegan más, esperan en la cola del pool
 * (pool.waitingCount), y esa espera aparece como latencia aunque la CPU y
 * el disco estén tranquilos ("contención", el cuarto sospechoso).
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

function entero(nombre: string, porDefecto: number): number {
  const valor = process.env[nombre];
  if (valor === undefined || valor === "") return porDefecto;
  const n = Number.parseInt(valor, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`La variable de entorno ${nombre} debe ser un entero positivo (valor recibido: "${valor}")`);
  }
  return n;
}

export const configuracionBD = {
  host: process.env.PGHOST ?? "localhost",
  port: entero("PGPORT", 5432),
  user: process.env.PGUSER ?? "postgres",
  password: process.env.PGPASSWORD ?? "postgres",
  database: process.env.PGDATABASE ?? "tienda_carga",
  max: entero("PG_POOL_MAX", 20),
  idleTimeoutMillis: entero("PG_IDLE_TIMEOUT_MS", 30_000),
  connectionTimeoutMillis: entero("PG_CONNECTION_TIMEOUT_MS", 10_000),
} as const;

export const pool = new Pool({
  host: configuracionBD.host,
  port: configuracionBD.port,
  user: configuracionBD.user,
  password: configuracionBD.password,
  database: configuracionBD.database,
  max: configuracionBD.max,
  idleTimeoutMillis: configuracionBD.idleTimeoutMillis,
  connectionTimeoutMillis: configuracionBD.connectionTimeoutMillis,
  application_name: "tienda-carga-api",
});

pool.on("error", (error: Error) => {
  // Un error en un cliente inactivo (p. ej. Postgres reiniciado) no debe
  // tumbar el proceso: el pool descarta ese cliente y abre otro.
  console.error("[bd] Error en un cliente inactivo del pool:", error.message);
});

/** Ejecuta una consulta usando cualquier conexión libre del pool. */
export async function consultar<T extends QueryResultRow>(
  texto: string,
  parametros: ReadonlyArray<unknown> = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(texto, parametros as unknown[]);
}

/** Códigos de error de Postgres que justifican reintentar la transacción. */
const ERRORES_REINTENTABLES = new Set<string>([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

function codigoError(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const codigo = (error as { code: unknown }).code;
    return typeof codigo === "string" ? codigo : undefined;
  }
  return undefined;
}

/**
 * Ejecuta `trabajo` dentro de una transacción explícita BEGIN … COMMIT.
 * Si algo falla hace ROLLBACK. Si el fallo es un interbloqueo o un error de
 * serialización (normales bajo alta concurrencia) reintenta hasta
 * `reintentos` veces con una espera aleatoria corta para desincronizar a los
 * competidores.
 */
export async function enTransaccion<T>(
  trabajo: (cliente: PoolClient) => Promise<T>,
  reintentos = 3,
): Promise<T> {
  let intento = 0;
  for (;;) {
    intento += 1;
    const cliente = await pool.connect();
    try {
      await cliente.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const resultado = await trabajo(cliente);
      await cliente.query("COMMIT");
      return resultado;
    } catch (error) {
      try {
        await cliente.query("ROLLBACK");
      } catch (errorRollback) {
        console.error("[bd] Falló el ROLLBACK:", (errorRollback as Error).message);
      }
      const codigo = codigoError(error);
      if (codigo !== undefined && ERRORES_REINTENTABLES.has(codigo) && intento <= reintentos) {
        const esperaMs = 5 + Math.floor(Math.random() * 20 * intento);
        await new Promise<void>((resolver) => setTimeout(resolver, esperaMs));
        continue;
      }
      throw error;
    } finally {
      cliente.release();
    }
  }
}

/** Estado del pool, expuesto en /api/metricas para medir contención. */
export function estadoPool(): { total: number; libres: number; esperando: number; maximo: number } {
  return {
    total: pool.totalCount,
    libres: pool.idleCount,
    esperando: pool.waitingCount,
    maximo: configuracionBD.max,
  };
}

/** Verifica que la base de datos responde. Se usa al arrancar y en /api/health. */
export async function verificarConexion(): Promise<{ ok: boolean; version: string }> {
  const r = await consultar<{ version: string }>("SELECT version() AS version");
  const fila = r.rows[0];
  return { ok: fila !== undefined, version: fila?.version ?? "desconocida" };
}

export async function cerrarPool(): Promise<void> {
  await pool.end();
}
