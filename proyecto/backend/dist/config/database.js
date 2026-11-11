"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = exports.configuracionBD = void 0;
exports.consultar = consultar;
exports.enTransaccion = enTransaccion;
exports.estadoPool = estadoPool;
exports.verificarConexion = verificarConexion;
exports.cerrarPool = cerrarPool;
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
const pg_1 = require("pg");
function entero(nombre, porDefecto) {
    const valor = process.env[nombre];
    if (valor === undefined || valor === "")
        return porDefecto;
    const n = Number.parseInt(valor, 10);
    if (Number.isNaN(n) || n <= 0) {
        throw new Error(`La variable de entorno ${nombre} debe ser un entero positivo (valor recibido: "${valor}")`);
    }
    return n;
}
exports.configuracionBD = {
    host: process.env.PGHOST ?? "localhost",
    port: entero("PGPORT", 5432),
    user: process.env.PGUSER ?? "postgres",
    password: process.env.PGPASSWORD ?? "postgres",
    database: process.env.PGDATABASE ?? "tienda_carga",
    max: entero("PG_POOL_MAX", 20),
    idleTimeoutMillis: entero("PG_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: entero("PG_CONNECTION_TIMEOUT_MS", 10_000),
};
exports.pool = new pg_1.Pool({
    host: exports.configuracionBD.host,
    port: exports.configuracionBD.port,
    user: exports.configuracionBD.user,
    password: exports.configuracionBD.password,
    database: exports.configuracionBD.database,
    max: exports.configuracionBD.max,
    idleTimeoutMillis: exports.configuracionBD.idleTimeoutMillis,
    connectionTimeoutMillis: exports.configuracionBD.connectionTimeoutMillis,
    application_name: "tienda-carga-api",
});
exports.pool.on("error", (error) => {
    // Un error en un cliente inactivo (p. ej. Postgres reiniciado) no debe
    // tumbar el proceso: el pool descarta ese cliente y abre otro.
    console.error("[bd] Error en un cliente inactivo del pool:", error.message);
});
/** Ejecuta una consulta usando cualquier conexión libre del pool. */
async function consultar(texto, parametros = []) {
    return exports.pool.query(texto, parametros);
}
/** Códigos de error de Postgres que justifican reintentar la transacción. */
const ERRORES_REINTENTABLES = new Set([
    "40001", // serialization_failure
    "40P01", // deadlock_detected
]);
function codigoError(error) {
    if (typeof error === "object" && error !== null && "code" in error) {
        const codigo = error.code;
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
async function enTransaccion(trabajo, reintentos = 3) {
    let intento = 0;
    for (;;) {
        intento += 1;
        const cliente = await exports.pool.connect();
        try {
            await cliente.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            const resultado = await trabajo(cliente);
            await cliente.query("COMMIT");
            return resultado;
        }
        catch (error) {
            try {
                await cliente.query("ROLLBACK");
            }
            catch (errorRollback) {
                console.error("[bd] Falló el ROLLBACK:", errorRollback.message);
            }
            const codigo = codigoError(error);
            if (codigo !== undefined && ERRORES_REINTENTABLES.has(codigo) && intento <= reintentos) {
                const esperaMs = 5 + Math.floor(Math.random() * 20 * intento);
                await new Promise((resolver) => setTimeout(resolver, esperaMs));
                continue;
            }
            throw error;
        }
        finally {
            cliente.release();
        }
    }
}
/** Estado del pool, expuesto en /api/metricas para medir contención. */
function estadoPool() {
    return {
        total: exports.pool.totalCount,
        libres: exports.pool.idleCount,
        esperando: exports.pool.waitingCount,
        maximo: exports.configuracionBD.max,
    };
}
/** Verifica que la base de datos responde. Se usa al arrancar y en /api/health. */
async function verificarConexion() {
    const r = await consultar("SELECT version() AS version");
    const fila = r.rows[0];
    return { ok: fila !== undefined, version: fila?.version ?? "desconocida" };
}
async function cerrarPool() {
    await exports.pool.end();
}
//# sourceMappingURL=database.js.map