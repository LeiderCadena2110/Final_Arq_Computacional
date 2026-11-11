/**
 * Módulo de autenticación.
 *
 * Dos costos de CPU distintos, que conviene distinguir en el informe:
 *
 * 1. Login: verificar la contraseña con scrypt (N=4096, r=8, p=1). scrypt
 *    está diseñado para ser caro en CPU y en memoria (≈4 MB por cálculo).
 *    En Node, crypto.scrypt asíncrono NO corre en el hilo del Event Loop:
 *    corre en el pool de hilos de libuv (4 hilos por defecto,
 *    UV_THREADPOOL_SIZE). Por eso en `pidstat -t` se ven varios hilos del
 *    proceso node consumiendo CPU durante los logins.
 *
 * 2. Rutas protegidas: cada petición verifica la firma HMAC-SHA256 del JWT
 *    (decodificar base64url, parsear JSON, recalcular el HMAC y comparar).
 *    Esto sí corre en el hilo principal, de forma síncrona, en cada petición:
 *    es un costo pequeño pero constante que se suma al tiempo de servicio
 *    del Event Loop.
 */
import { NextFunction, Request, Response } from "express";
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import jwt, { JwtPayload } from "jsonwebtoken";
import { consultar } from "../../config/database";

export type Rol = "admin" | "vendedor";

export interface UsuarioToken {
  id: number;
  nombre: string;
  email: string;
  rol: Rol;
}

/** Petición ya autenticada: el middleware garantiza que `usuario` existe. */
export interface PeticionAutenticada extends Request {
  usuario?: UsuarioToken;
}

/** Error con código HTTP, capturado por el manejador central del servidor. */
export class ErrorHttp extends Error {
  public readonly estado: number;
  public readonly detalle?: unknown;

  constructor(estado: number, mensaje: string, detalle?: unknown) {
    super(mensaje);
    this.name = "ErrorHttp";
    this.estado = estado;
    this.detalle = detalle;
  }
}

/** Envuelve un controlador asíncrono para que sus errores lleguen a next(). */
export function asincrono(
  manejador: (req: PeticionAutenticada, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    manejador(req as PeticionAutenticada, res, next).catch(next);
  };
}

// -----------------------------------------------------------------------------
//  Configuración del JWT
// -----------------------------------------------------------------------------
const SECRETO_POR_DEFECTO = "cambie-este-secreto-en-produccion-ucc-pasto-2026";
const JWT_SECRETO: string = process.env.JWT_SECRET ?? SECRETO_POR_DEFECTO;
const JWT_EXPIRACION_SEGUNDOS: number = Number.parseInt(process.env.JWT_EXPIRES_SECONDS ?? "28800", 10); // 8 h

if (JWT_SECRETO === SECRETO_POR_DEFECTO) {
  console.warn("[auth] JWT_SECRET no está definido: se usa el secreto de desarrollo. No lo use fuera del laboratorio.");
}

// -----------------------------------------------------------------------------
//  Contraseñas con scrypt
// -----------------------------------------------------------------------------
interface ParametrosScrypt {
  N: number;
  r: number;
  p: number;
  sal: Buffer;
  hash: Buffer;
}

function scryptAsync(password: string, sal: Buffer, longitud: number, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise<Buffer>((resolver, rechazar) => {
    // maxmem debe cubrir 128 * N * r bytes; se deja holgura.
    scrypt(password, sal, longitud, { N, r, p, maxmem: 256 * N * r }, (error, derivada) => {
      if (error) rechazar(error);
      else resolver(derivada);
    });
  });
}

function parsearHash(almacenado: string): ParametrosScrypt | null {
  const partes = almacenado.split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return null;
  const [, nTexto, rTexto, pTexto, salHex, hashHex] = partes as [string, string, string, string, string, string];
  const N = Number.parseInt(nTexto, 10);
  const r = Number.parseInt(rTexto, 10);
  const p = Number.parseInt(pTexto, 10);
  if ([N, r, p].some((x) => Number.isNaN(x) || x <= 0)) return null;
  return { N, r, p, sal: Buffer.from(salHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

/** Genera un hash nuevo en el mismo formato que usa base_de_datos.sql. */
export async function generarHash(password: string, N = 4096, r = 8, p = 1): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scryptAsync(password, sal, 64, N, r, p);
  return `scrypt$${N}$${r}$${p}$${sal.toString("hex")}$${hash.toString("hex")}`;
}

export async function verificarPassword(password: string, almacenado: string): Promise<boolean> {
  const parametros = parsearHash(almacenado);
  if (parametros === null) return false;
  const calculado = await scryptAsync(password, parametros.sal, parametros.hash.length, parametros.N, parametros.r, parametros.p);
  // Comparación en tiempo constante: no revela por tiempo cuántos bytes coinciden.
  return calculado.length === parametros.hash.length && timingSafeEqual(calculado, parametros.hash);
}

// Hash de relleno para que un email inexistente cueste lo mismo que uno real
// (evita enumerar usuarios midiendo la latencia del login).
let hashRellenoPromesa: Promise<string> | null = null;
function hashDeRelleno(): Promise<string> {
  if (hashRellenoPromesa === null) hashRellenoPromesa = generarHash("relleno-no-valido");
  return hashRellenoPromesa;
}

// -----------------------------------------------------------------------------
//  Controladores
// -----------------------------------------------------------------------------
interface FilaUsuario {
  id: number;
  nombre: string;
  email: string;
  password_hash: string;
  rol: Rol;
  activo: boolean;
}

function firmarToken(usuario: UsuarioToken): string {
  return jwt.sign(
    { nombre: usuario.nombre, email: usuario.email, rol: usuario.rol },
    JWT_SECRETO,
    { algorithm: "HS256", subject: String(usuario.id), expiresIn: JWT_EXPIRACION_SEGUNDOS, issuer: "tienda-carga-api" },
  );
}

/** POST /api/auth/login  { email, password } */
export const login = asincrono(async (req, res) => {
  const cuerpo: unknown = req.body;
  if (typeof cuerpo !== "object" || cuerpo === null) {
    throw new ErrorHttp(400, "El cuerpo de la petición debe ser un objeto JSON");
  }
  const { email, password } = cuerpo as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || typeof password !== "string" || email.trim() === "" || password === "") {
    throw new ErrorHttp(400, "Debe enviar email y password");
  }
  if (email.length > 160 || password.length > 200) {
    throw new ErrorHttp(400, "Email o password demasiado largos");
  }

  const resultado = await consultar<FilaUsuario>(
    "SELECT id, nombre, email, password_hash, rol, activo FROM usuarios WHERE email = $1",
    [email.trim().toLowerCase()],
  );
  const fila = resultado.rows[0];

  const valido = fila !== undefined
    ? await verificarPassword(password, fila.password_hash)
    : (await verificarPassword(password, await hashDeRelleno()), false);

  if (fila === undefined || !valido || !fila.activo) {
    throw new ErrorHttp(401, "Credenciales inválidas");
  }

  // Escritura pequeña en cada login: también cuenta como IOPS en el disco.
  await consultar("UPDATE usuarios SET ultimo_acceso = NOW() WHERE id = $1", [fila.id]);

  const usuario: UsuarioToken = { id: fila.id, nombre: fila.nombre, email: fila.email, rol: fila.rol };
  const token = firmarToken(usuario);
  res.json({ token, tipo: "Bearer", expiraEnSegundos: JWT_EXPIRACION_SEGUNDOS, usuario });
});

/** GET /api/auth/perfil  (protegida) */
export const perfil = asincrono(async (req, res) => {
  const usuario = req.usuario;
  if (usuario === undefined) throw new ErrorHttp(401, "No autenticado");
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
export function verificarToken(req: Request, _res: Response, next: NextFunction): void {
  const cabecera = req.headers.authorization;
  if (cabecera === undefined || !cabecera.startsWith("Bearer ")) {
    next(new ErrorHttp(401, "Falta el token (cabecera Authorization: Bearer <token>)"));
    return;
  }
  const token = cabecera.slice("Bearer ".length).trim();
  try {
    const decodificado = jwt.verify(token, JWT_SECRETO, {
      algorithms: ["HS256"],
      issuer: "tienda-carga-api",
    });
    if (typeof decodificado === "string") throw new Error("Carga útil inesperada");
    const carga = decodificado as JwtPayload & { nombre?: unknown; email?: unknown; rol?: unknown };
    const id = Number.parseInt(carga.sub ?? "", 10);
    if (
      Number.isNaN(id) ||
      typeof carga.nombre !== "string" ||
      typeof carga.email !== "string" ||
      (carga.rol !== "admin" && carga.rol !== "vendedor")
    ) {
      throw new Error("Carga útil incompleta");
    }
    (req as PeticionAutenticada).usuario = { id, nombre: carga.nombre, email: carga.email, rol: carga.rol };
    next();
  } catch (error) {
    const mensaje = error instanceof jwt.TokenExpiredError ? "El token expiró" : "Token inválido";
    next(new ErrorHttp(401, mensaje));
  }
}

/** Restringe una ruta a uno o varios roles. Debe ir después de verificarToken. */
export function requerirRol(...roles: Rol[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const usuario = (req as PeticionAutenticada).usuario;
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
