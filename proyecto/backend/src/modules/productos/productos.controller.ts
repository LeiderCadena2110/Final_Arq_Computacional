/**
 * Módulo de productos (catálogo e inventario).
 *
 * La consulta de catálogo es la operación más frecuente de la prueba de carga
 * (60 %). Es una lectura: casi siempre se resuelve desde la caché de páginas
 * de Postgres (shared_buffers) y del sistema operativo (page cache), así que
 * genera muy pocas lecturas físicas de disco. Su costo real está en:
 *   - el viaje de red Node ↔ Postgres,
 *   - convertir las filas a objetos JavaScript (driver pg),
 *   - serializar la respuesta a JSON (JSON.stringify, síncrono, en el hilo
 *     del Event Loop) y enviarla por la red.
 */
import { Response } from "express";
import { consultar } from "../../config/database";
import { asincrono, ErrorHttp, PeticionAutenticada } from "../auth/auth.controller";

interface FilaProducto {
  id: number;
  sku: string;
  nombre: string;
  descripcion: string | null;
  precio: string; // NUMERIC llega como texto para no perder precisión
  stock: number;
  stock_minimo: number;
  categoria_id: number;
  categoria: string;
  categoria_slug: string;
}

interface Producto {
  id: number;
  sku: string;
  nombre: string;
  descripcion: string | null;
  precio: number;
  stock: number;
  stockMinimo: number;
  categoria: { id: number; nombre: string; slug: string };
}

function aProducto(f: FilaProducto): Producto {
  return {
    id: f.id,
    sku: f.sku,
    nombre: f.nombre,
    descripcion: f.descripcion,
    precio: Number(f.precio),
    stock: f.stock,
    stockMinimo: f.stock_minimo,
    categoria: { id: f.categoria_id, nombre: f.categoria, slug: f.categoria_slug },
  };
}

function enteroQuery(valor: unknown, porDefecto: number, minimo: number, maximo: number): number {
  if (valor === undefined || valor === "") return porDefecto;
  if (typeof valor !== "string") throw new ErrorHttp(400, "Parámetro numérico inválido");
  const n = Number.parseInt(valor, 10);
  if (Number.isNaN(n)) throw new ErrorHttp(400, `"${valor}" no es un número`);
  return Math.min(Math.max(n, minimo), maximo);
}

/**
 * GET /api/productos?categoria=<id|slug>&busqueda=<texto>&limite=50&pagina=1
 * Lectura filtrada del catálogo por categoría.
 */
export const listarProductos = asincrono(async (req: PeticionAutenticada, res: Response) => {
  const { categoria, busqueda } = req.query;
  const limite = enteroQuery(req.query.limite, 50, 1, 200);
  const pagina = enteroQuery(req.query.pagina, 1, 1, 10_000);

  const condiciones: string[] = ["p.activo = TRUE"];
  const parametros: unknown[] = [];

  if (typeof categoria === "string" && categoria !== "") {
    if (/^\d+$/.test(categoria)) {
      parametros.push(Number.parseInt(categoria, 10));
      condiciones.push(`p.categoria_id = $${parametros.length}`);
    } else {
      parametros.push(categoria.toLowerCase());
      condiciones.push(`c.slug = $${parametros.length}`);
    }
  } else if (categoria !== undefined && typeof categoria !== "string") {
    throw new ErrorHttp(400, "El parámetro categoria debe ser un id o un slug");
  }

  if (typeof busqueda === "string" && busqueda.trim() !== "") {
    parametros.push(`%${busqueda.trim().toLowerCase()}%`);
    condiciones.push(`LOWER(p.nombre) LIKE $${parametros.length}`);
  }

  const where = condiciones.join(" AND ");

  parametros.push(limite);
  const pLimite = parametros.length;
  parametros.push((pagina - 1) * limite);
  const pOffset = parametros.length;

  // COUNT(*) OVER () devuelve el total sin una segunda consulta.
  const resultado = await consultar<FilaProducto & { total: string }>(
    `SELECT p.id, p.sku, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo,
            p.categoria_id, c.nombre AS categoria, c.slug AS categoria_slug,
            COUNT(*) OVER () AS total
       FROM productos p
       JOIN categorias c ON c.id = p.categoria_id
      WHERE ${where}
      ORDER BY p.categoria_id, p.nombre
      LIMIT $${pLimite} OFFSET $${pOffset}`,
    parametros,
  );

  const total = resultado.rows[0] !== undefined ? Number(resultado.rows[0].total) : 0;
  res.json({
    pagina,
    limite,
    total,
    paginas: Math.ceil(total / limite),
    productos: resultado.rows.map(aProducto),
  });
});

/** GET /api/productos/categorias — categorías con conteo de productos activos. */
export const listarCategorias = asincrono(async (_req: PeticionAutenticada, res: Response) => {
  const resultado = await consultar<{ id: number; nombre: string; slug: string; descripcion: string | null; productos: string }>(
    `SELECT c.id, c.nombre, c.slug, c.descripcion, COUNT(p.id) AS productos
       FROM categorias c
       LEFT JOIN productos p ON p.categoria_id = c.id AND p.activo
      GROUP BY c.id
      ORDER BY c.nombre`,
  );
  res.json({
    categorias: resultado.rows.map((f) => ({
      id: f.id,
      nombre: f.nombre,
      slug: f.slug,
      descripcion: f.descripcion,
      productos: Number(f.productos),
    })),
  });
});

/** GET /api/productos/inventario — solo admin: inventario completo y alertas. */
export const inventario = asincrono(async (_req: PeticionAutenticada, res: Response) => {
  const [productos, resumen] = await Promise.all([
    consultar<FilaProducto>(
      `SELECT p.id, p.sku, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo,
              p.categoria_id, c.nombre AS categoria, c.slug AS categoria_slug
         FROM productos p
         JOIN categorias c ON c.id = p.categoria_id
        WHERE p.activo
        ORDER BY (p.stock <= p.stock_minimo) DESC, p.stock ASC, p.nombre`,
    ),
    consultar<{ productos: string; unidades: string; valor_inventario: string; bajo_minimo: string }>(
      `SELECT COUNT(*)                               AS productos,
              COALESCE(SUM(stock), 0)                AS unidades,
              COALESCE(SUM(stock * precio), 0)       AS valor_inventario,
              COUNT(*) FILTER (WHERE stock <= stock_minimo) AS bajo_minimo
         FROM productos
        WHERE activo`,
    ),
  ]);
  const r = resumen.rows[0];
  res.json({
    resumen: {
      productos: Number(r?.productos ?? 0),
      unidades: Number(r?.unidades ?? 0),
      valorInventario: Number(r?.valor_inventario ?? 0),
      bajoMinimo: Number(r?.bajo_minimo ?? 0),
    },
    productos: productos.rows.map(aProducto),
  });
});

/** GET /api/productos/:id */
export const obtenerProducto = asincrono(async (req: PeticionAutenticada, res: Response) => {
  const idTexto = req.params.id ?? "";
  if (!/^\d+$/.test(idTexto)) throw new ErrorHttp(400, "El id debe ser numérico");
  const resultado = await consultar<FilaProducto>(
    `SELECT p.id, p.sku, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo,
            p.categoria_id, c.nombre AS categoria, c.slug AS categoria_slug
       FROM productos p
       JOIN categorias c ON c.id = p.categoria_id
      WHERE p.id = $1`,
    [Number.parseInt(idTexto, 10)],
  );
  const fila = resultado.rows[0];
  if (fila === undefined) throw new ErrorHttp(404, "Producto no encontrado");
  res.json({ producto: aProducto(fila) });
});
