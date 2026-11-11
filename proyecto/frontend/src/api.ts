/**
 * Cliente HTTP mínimo para la API y tipos compartidos por los componentes.
 * El JWT se guarda en localStorage y se envía en la cabecera Authorization.
 */

export type Rol = "admin" | "vendedor";

export interface Usuario {
  id: number;
  nombre: string;
  email: string;
  rol: Rol;
}

export interface Categoria {
  id: number;
  nombre: string;
  slug: string;
  descripcion: string | null;
  productos: number;
}

export interface Producto {
  id: number;
  sku: string;
  nombre: string;
  descripcion: string | null;
  precio: number;
  stock: number;
  stockMinimo: number;
  categoria: { id: number; nombre: string; slug: string };
}

export interface RespuestaCatalogo {
  pagina: number;
  limite: number;
  total: number;
  paginas: number;
  productos: Producto[];
}

export interface RespuestaLogin {
  token: string;
  tipo: "Bearer";
  expiraEnSegundos: number;
  usuario: Usuario;
}

export interface VentaRegistrada {
  ventaId: number;
  fecha: string;
  total: number;
  cantidadItems: number;
  items: Array<{ productoId: number; nombre: string; cantidad: number; precioUnitario: number; subtotal: number; stockRestante: number }>;
}

export interface ResumenInventario {
  resumen: { productos: number; unidades: number; valorInventario: number; bajoMinimo: number };
  productos: Producto[];
}

export interface ResumenVentas {
  totales: { ventas: number; ingresos: number; unidades: number; ticketPromedio: number };
  ultimaHora: { ventas: number; ingresos: number };
  porMinuto: Array<{ minuto: string; ventas: number; ingresos: number }>;
  topProductos: Array<{ productoId: number; nombre: string; unidades: number; ingresos: number }>;
  porVendedor: Array<{ vendedor: string; ventas: number; ingresos: number }>;
}

export interface VentaListada {
  id: number;
  fecha: string;
  total: number;
  cantidadItems: number;
  estado: string;
  vendedor: string;
}

const CLAVE_TOKEN = "tienda.jwt";
const CLAVE_USUARIO = "tienda.usuario";
export const EVENTO_SESION_EXPIRADA = "tienda:sesion-expirada";

// Vacío = mismo origen (el proxy de Vite reenvía /api al backend).
const BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

export class ErrorApi extends Error {
  readonly estado: number;
  readonly detalle: unknown;
  constructor(estado: number, mensaje: string, detalle?: unknown) {
    super(mensaje);
    this.estado = estado;
    this.detalle = detalle;
  }
}

export function guardarSesion(token: string, usuario: Usuario): void {
  localStorage.setItem(CLAVE_TOKEN, token);
  localStorage.setItem(CLAVE_USUARIO, JSON.stringify(usuario));
}

export function leerSesion(): { token: string; usuario: Usuario } | null {
  const token = localStorage.getItem(CLAVE_TOKEN);
  const crudo = localStorage.getItem(CLAVE_USUARIO);
  if (token === null || crudo === null) return null;
  try {
    const usuario = JSON.parse(crudo) as Usuario;
    if (usuario.rol !== "admin" && usuario.rol !== "vendedor") return null;
    return { token, usuario };
  } catch {
    return null;
  }
}

export function borrarSesion(): void {
  localStorage.removeItem(CLAVE_TOKEN);
  localStorage.removeItem(CLAVE_USUARIO);
}

export async function apiFetch<T>(ruta: string, opciones: { metodo?: "GET" | "POST"; cuerpo?: unknown; autenticado?: boolean } = {}): Promise<T> {
  const { metodo = "GET", cuerpo, autenticado = true } = opciones;
  const cabeceras: Record<string, string> = { Accept: "application/json" };
  if (cuerpo !== undefined) cabeceras["Content-Type"] = "application/json";
  if (autenticado) {
    const token = localStorage.getItem(CLAVE_TOKEN);
    if (token !== null) cabeceras.Authorization = `Bearer ${token}`;
  }

  let respuesta: Response;
  try {
    respuesta = await fetch(`${BASE_URL}${ruta}`, {
      method: metodo,
      headers: cabeceras,
      body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
    });
  } catch {
    throw new ErrorApi(0, "No se pudo contactar al servidor. ¿Está corriendo el backend?");
  }

  const texto = await respuesta.text();
  let datos: unknown = null;
  if (texto !== "") {
    try {
      datos = JSON.parse(texto);
    } catch {
      datos = { error: texto };
    }
  }

  if (!respuesta.ok) {
    const mensaje =
      typeof datos === "object" && datos !== null && "error" in datos && typeof (datos as { error: unknown }).error === "string"
        ? (datos as { error: string }).error
        : `Error HTTP ${respuesta.status}`;
    if (respuesta.status === 401 && autenticado) {
      window.dispatchEvent(new Event(EVENTO_SESION_EXPIRADA));
    }
    throw new ErrorApi(respuesta.status, mensaje, (datos as { detalle?: unknown } | null)?.detalle);
  }
  return datos as T;
}

const formatoPesos = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const formatoNumero = new Intl.NumberFormat("es-CO");

export const pesos = (valor: number): string => formatoPesos.format(valor);
export const numero = (valor: number): string => formatoNumero.format(valor);
