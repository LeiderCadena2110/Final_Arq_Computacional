"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.perfil = exports.login = exports.ErrorHttp = void 0;
exports.asincrono = asincrono;
exports.generarHash = generarHash;
exports.verificarPassword = verificarPassword;
exports.verificarToken = verificarToken;
exports.requerirRol = requerirRol;
const crypto_1 = require("crypto");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../../config/database");
/** Error con código HTTP, capturado por el manejador central del servidor. */
class ErrorHttp extends Error {
    estado;
    detalle;
    constructor(estado, mensaje, detalle) {
        super(mensaje);
        this.name = "ErrorHttp";
        this.estado = estado;
        this.detalle = detalle;
    }
}
exports.ErrorHttp = ErrorHttp;
/** Envuelve un controlador asíncrono para que sus errores lleguen a next(). */
function asincrono(manejador) {
    return (req, res, next) => {
        manejador(req, res, next).catch(next);
    };
}
// -----------------------------------------------------------------------------
//  Configuración del JWT
// -----------------------------------------------------------------------------
const SECRETO_POR_DEFECTO = "cambie-este-secreto-en-produccion-ucc-pasto-2026";
const JWT_SECRETO = process.env.JWT_SECRET ?? SECRETO_POR_DEFECTO;
const JWT_EXPIRACION_SEGUNDOS = Number.parseInt(process.env.JWT_EXPIRES_SECONDS ?? "28800", 10); // 8 h
if (JWT_SECRETO === SECRETO_POR_DEFECTO) {
    console.warn("[auth] JWT_SECRET no está definido: se usa el secreto de desarrollo. No lo use fuera del laboratorio.");
}
function scryptAsync(password, sal, longitud, N, r, p) {
    return new Promise((resolver, rechazar) => {
        // maxmem debe cubrir 128 * N * r bytes; se deja holgura.
        (0, crypto_1.scrypt)(password, sal, longitud, { N, r, p, maxmem: 256 * N * r }, (error, derivada) => {
            if (error)
                rechazar(error);
            else
                resolver(derivada);
        });
    });
}
function parsearHash(almacenado) {
    const partes = almacenado.split("$");
    if (partes.length !== 6 || partes[0] !== "scrypt")
        return null;
    const [, nTexto, rTexto, pTexto, salHex, hashHex] = partes;
    const N = Number.parseInt(nTexto, 10);
    const r = Number.parseInt(rTexto, 10);
    const p = Number.parseInt(pTexto, 10);
    if ([N, r, p].some((x) => Number.isNaN(x) || x <= 0))
        return null;
    return { N, r, p, sal: Buffer.from(salHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}
/** Genera un hash nuevo en el mismo formato que usa base_de_datos.sql. */
async function generarHash(password, N = 4096, r = 8, p = 1) {
    const sal = (0, crypto_1.randomBytes)(16);
    const hash = await scryptAsync(password, sal, 64, N, r, p);
    return `scrypt$${N}$${r}$${p}$${sal.toString("hex")}$${hash.toString("hex")}`;
}
async function verificarPassword(password, almacenado) {
    const parametros = parsearHash(almacenado);
    if (parametros === null)
        return false;
    const calculado = await scryptAsync(password, parametros.sal, parametros.hash.length, parametros.N, parametros.r, parametros.p);
    // Comparación en tiempo constante: no revela por tiempo cuántos bytes coinciden.
    return calculado.length === parametros.hash.length && (0, crypto_1.timingSafeEqual)(calculado, parametros.hash);
}
// Hash de relleno para que un email inexistente cueste lo mismo que uno real
// (evita enumerar usuarios midiendo la latencia del login).
let hashRellenoPromesa = null;
function hashDeRelleno() {
    if (hashRellenoPromesa === null)
        hashRellenoPromesa = generarHash("relleno-no-valido");
    return hashRellenoPromesa;
}
function firmarToken(usuario) {
    return jsonwebtoken_1.default.sign({ nombre: usuario.nombre, email: usuario.email, rol: usuario.rol }, JWT_SECRETO, { algorithm: "HS256", subject: String(usuario.id), expiresIn: JWT_EXPIRACION_SEGUNDOS, issuer: "tienda-carga-api" });
}
/** POST /api/auth/login  { email, password } */
exports.login = asincrono(async (req, res) => {
    const cuerpo = req.body;
    if (typeof cuerpo !== "object" || cuerpo === null) {
        throw new ErrorHttp(400, "El cuerpo de la petición debe ser un objeto JSON");
    }
    const { email, password } = cuerpo;
    if (typeof email !== "string" || typeof password !== "string" || email.trim() === "" || password === "") {
        throw new ErrorHttp(400, "Debe enviar email y password");
    }
    if (email.length > 160 || password.length > 200) {
        throw new ErrorHttp(400, "Email o password demasiado largos");
    }
    const resultado = await (0, database_1.consultar)("SELECT id, nombre, email, password_hash, rol, activo FROM usuarios WHERE email = $1", [email.trim().toLowerCase()]);
    const fila = resultado.rows[0];
    const valido = fila !== undefined
        ? await verificarPassword(password, fila.password_hash)
        : (await verificarPassword(password, await hashDeRelleno()), false);
    if (fila === undefined || !valido || !fila.activo) {
        throw new ErrorHttp(401, "Credenciales inválidas");
    }
    // Escritura pequeña en cada login: también cuenta como IOPS en el disco.
    await (0, database_1.consultar)("UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1", [fila.id]);
    const usuario = { id: fila.id, nombre: fila.nombre, email: fila.email, rol: fila.rol };
    const token = firmarToken(usuario);
    res.json({ token, tipo: "Bearer", expiraEnSegundos: JWT_EXPIRACION_SEGUNDOS, usuario });
});
/** GET /api/auth/perfil  (protegida) */
exports.perfil = asincrono(async (req, res) => {
    const usuario = req.usuario;
    if (usuario === undefined)
        throw new ErrorHttp(401, "No autenticado");
    res.json({ usuario });
});
// -----------------------------------------------------------------------------
//  Middlewares
// -----------------------------------------------------------------------------
/**
 * Verifica el JWT en cada petición protegida. jwt.verify es síncrono:
 * decodifica, recalcula el HMAC-SHA256 con el secreto y valida expiración,
 * emisor y algoritmo. Ese trabajo ocupa el hilo del Event Loop en cada
 * petición, y es parte del "tiempo de servicio" S que se usa en el informe.
 */
function verificarToken(req, _res, next) {
    const cabecera = req.headers.authorization;
    if (cabecera === undefined || !cabecera.startsWith("Bearer ")) {
        next(new ErrorHttp(401, "Falta el token (cabecera Authorization: Bearer <token>)"));
        return;
    }
    const token = cabecera.slice("Bearer ".length).trim();
    try {
        const decodificado = jsonwebtoken_1.default.verify(token, JWT_SECRETO, {
            algorithms: ["HS256"],
            issuer: "tienda-carga-api",
        });
        if (typeof decodificado === "string")
            throw new Error("Carga útil inesperada");
        const carga = decodificado;
        const id = Number.parseInt(carga.sub ?? "", 10);
        if (Number.isNaN(id) ||
            typeof carga.nombre !== "string" ||
            typeof carga.email !== "string" ||
            (carga.rol !== "admin" && carga.rol !== "vendedor")) {
            throw new Error("Carga útil incompleta");
        }
        req.usuario = { id, nombre: carga.nombre, email: carga.email, rol: carga.rol };
        next();
    }
    catch (error) {
        const mensaje = error instanceof jsonwebtoken_1.default.TokenExpiredError ? "El token expiró" : "Token inválido";
        next(new ErrorHttp(401, mensaje));
    }
}
/** Restringe una ruta a uno o varios roles. Debe ir después de verificarToken. */
function requerirRol(...roles) {
    return (req, _res, next) => {
        const usuario = req.usuario;
        if (usuario === undefined) {
            next(new ErrorHttp(401, "No autenticado"));
            return;
        }
        if (!roles.includes(usuario.rol)) {
            next(new ErrorHttp(403, `Esta operación requiere rol: ${roles.join(" o ")}`));
            return;
        }
        next();
    };
}
//# sourceMappingURL=auth.controller.js.map