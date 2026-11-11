"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.obtenerProducto = exports.inventario = exports.listarCategorias = exports.listarProductos = void 0;
const database_1 = require("../../config/database");
const auth_controller_1 = require("../auth/auth.controller");
function aProducto(f) {
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
function enteroQuery(valor, porDefecto, minimo, maximo) {
    if (valor === undefined || valor === "")
        return porDefecto;
    if (typeof valor !== "string")
        throw new auth_controller_1.ErrorHttp(400, "Parámetro numérico inválido");
    const n = Number.parseInt(valor, 10);
    if (Number.isNaN(n))
        throw new auth_controller_1.ErrorHttp(400, `"${valor}" no es un número`);
    return Math.min(Math.max(n, minimo), maximo);
}
/**
 * GET /api/productos?categoria=<id|slug>&busqueda=<texto>&limite=50&pagina=1
 * Lectura filtrada del catálogo por categoría.
 */
exports.listarProductos = (0, auth_controller_1.asincrono)(async (req, res) => {
    const { categoria, busqueda } = req.query;
    const limite = enteroQuery(req.query.limite, 50, 1, 200);
    const pagina = enteroQuery(req.query.pagina, 1, 1, 10_000);
    const condiciones = ["p.activo = TRUE"];
    const parametros = [];
    if (typeof categoria === "string" && categoria !== "") {
        if (/^\d+$/.test(categoria)) {
            parametros.push(Number.parseInt(categoria, 10));
            condiciones.push(`p.categoria_id = $${parametros.length}`);
        }
        else {
            parametros.push(categoria.toLowerCase());
            condiciones.push(`c.slug = $${parametros.length}`);
        }
    }
    else if (categoria !== undefined && typeof categoria !== "string") {
        throw new auth_controller_1.ErrorHttp(400, "El parámetro categoria debe ser un id o un slug");
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
    const resultado = await (0, database_1.consultar)(`SELECT p.id, p.sku, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo,
            p.categoria_id, c.nombre AS categoria, c.slug AS categoria_slug,
            COUNT(*) OVER () AS total
       FROM productos p
       JOIN categorias c ON c.id = p.categoria_id
      WHERE ${where}
      ORDER BY p.categoria_id, p.nombre
      LIMIT $${pLimite} OFFSET $${pOffset}`, parametros);
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
exports.listarCategorias = (0, auth_controller_1.asincrono)(async (_req, res) => {
    const resultado = await (0, database_1.consultar)(`SELECT c.id, c.nombre, c.slug, c.descripcion, COUNT(p.id) AS productos
       FROM categorias c
       LEFT JOIN productos p ON p.categoria_id = c.id AND p.activo
      GROUP BY c.id
      ORDER BY c.nombre`);
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
exports.inventario = (0, auth_controller_1.asincrono)(async (_req, res) => {
    const [productos, resumen] = await Promise.all([
        (0, database_1.consultar)(`SELECT p.id, p.sku, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo,
              p.categoria_id, c.nombre AS categoria, c.slug AS categoria_slug
         FROM productos p
         JOIN categorias c ON c.id = p.categoria_id
        WHERE p.activo
        ORDER BY (p.stock <= p.stock_minimo) DESC, p.stock ASC, p.nombre`),
        (0, database_1.consultar)(`SELECT COUNT(*)                               AS productos,
              COALESCE(SUM(stock), 0)                AS unidades,
              COALESCE(SUM(stock * precio), 0)       AS valor_inventario,
              COUNT(*) FILTER (WHERE stock <= stock_minimo) AS bajo_minimo
         FROM productos
        WHERE activo`),
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
exports.obtenerProducto = (0, auth_controller_1.asincrono)(async (req, res) => {
    const idTexto = req.params.id ?? "";
    if (!/^\d+$/.test(idTexto))
        throw new auth_controller_1.ErrorHttp(400, "El id debe ser numérico");
    const resultado = await (0, database_1.consultar)(`SELECT p.id, p.sku, p.nombre, p.descripcion, p.precio, p.stock, p.stock_minimo,
            p.categoria_id, c.nombre AS categoria, c.slug AS categoria_slug
       FROM productos p
       JOIN categorias c ON c.id = p.categoria_id
      WHERE p.id = $1`, [Number.parseInt(idTexto, 10)]);
    const fila = resultado.rows[0];
    if (fila === undefined)
        throw new auth_controller_1.ErrorHttp(404, "Producto no encontrado");
    res.json({ producto: aProducto(fila) });
});
//# sourceMappingURL=productos.controller.js.map