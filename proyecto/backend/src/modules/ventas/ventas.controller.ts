/**
 * Módulo de ventas.
 *
 * POST /api/ventas es la operación que estresa el almacenamiento. Cada venta
 * ejecuta, dentro de UNA transacción explícita (BEGIN … COMMIT):
 *
 *   1. SELECT … FOR UPDATE de los productos (lectura de validación + bloqueo
 *      de fila). Los productos se bloquean siempre en orden ascendente de id
 *      para que dos ventas concurrentes no se bloqueen en cruz (interbloqueo).
 *   2. INSERT del encabezado en `ventas`.
 *   3. INSERT de N filas en `detalle_ventas`.
 *   4. UPDATE de `productos` restando el stock (con CHECK stock >= 0).
 *   5. INSERT de N filas en `movimientos_inventario` (kárdex).
 *   6. UPDATE del total de la venta.
 *   7. SELECT de validación final (relee lo escrito y compara totales).
 *   8. COMMIT: Postgres escribe el WAL y hace fsync antes de responder.
 *
 * El paso 8 es el que convierte cada venta en, como mínimo, una escritura
 * física sincrónica al disco (synchronous_commit = on). Por eso el número de
 * ventas por segundo se refleja casi uno a uno en w/s de `iostat -x 1`, y la
 * latencia de esa escritura (w_await) se suma a la latencia de la venta.
 *
 * Mientras la transacción está abierta, las filas de productos quedan
 * bloqueadas: otra venta del mismo producto espera. Ese tiempo de espera es
 * contención pura, no aparece como CPU ni como disco.
 */
import { Response } from "express";
import { PoolClient } from "pg";
import { consultar, enTransaccion } from "../../config/database";
import { asincrono, ErrorHttp, PeticionAutenticada } from "../auth/auth.controller";

const MAX_ITEMS_POR_VENTA = 50;
const MAX_CANTIDAD_POR_ITEM = 1000;

interface ItemSolicitado {
  productoId: number;
  cantidad: number;
}

interface FilaBloqueada {
  id: number;
  nombre: string;
  precio: string;
  stock: number;
  activo: boolean;
}

function validarItems(cuerpo: unknown): ItemSolicitado[] {
  if (typeof cuerpo !== "object" || cuerpo === null || !("items" in cuerpo)) {
    throw new ErrorHttp(400, "El cuerpo debe tener la forma { items: [{ productoId, cantidad }] }");
  }
  const items = (cuerpo as { items: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ErrorHttp(400, "La venta debe tener al menos un ítem");
  }
  if (items.length > MAX_ITEMS_POR_VENTA) {
    throw new ErrorHttp(400, `Máximo ${MAX_ITEMS_POR_VENTA} ítems por venta`);
  }

  // Se agrupan ítems repetidos del mismo producto: así cada producto se
  // bloquea y se descuenta una sola vez.
  const agrupados = new Map<number, number>();
  for (const item of items as unknown[]) {
    if (typeof item !== "object" || item === null) throw new ErrorHttp(400, "Ítem inválido");
    const { productoId, cantidad } = item as { productoId?: unknown; cantidad?: unknown };
    if (typeof productoId !== "number" || !Number.isInteger(productoId) || productoId <= 0) {
      throw new ErrorHttp(400, "productoId debe ser un entero positivo");
    }
    if (typeof cantidad !== "number" || !Number.isInteger(cantidad) || cantidad <= 0 || cantidad > MAX_CANTIDAD_POR_ITEM) {
      throw new ErrorHttp(400, `cantidad debe ser un entero entre 1 y ${MAX_CANTIDAD_POR_ITEM}`);
    }
    agrupados.set(productoId, (agrupados.get(productoId) ?? 0) + cantidad);
  }

  return [...agrupados.entries()]
    .map(([productoId, cantidad]) => ({ productoId, cantidad }))
    .sort((a, b) => a.productoId - b.productoId); // orden fijo de bloqueo
}

interface ResultadoVenta {
  ventaId: number;
  fecha: string;
  total: number;
  cantidadItems: number;
  items: Array<{ productoId: number; nombre: string; cantidad: number; precioUnitario: number; subtotal: number; stockRestante: number }>;
}

async function registrarVenta(cliente: PoolClient, usuarioId: number, items: ItemSolicitado[]): Promise<ResultadoVenta> {
  const ids = items.map((i) => i.productoId);
  const cantidades = items.map((i) => i.cantidad);

  // 1. Lectura de validación con bloqueo de fila, en orden de id.
  const bloqueadas = await cliente.query<FilaBloqueada>(
    `SELECT id, nombre, precio, stock, activo
       FROM productos
      WHERE id = ANY($1::int[])
      ORDER BY id
        FOR UPDATE`,
    [ids],
  );
  const porId = new Map<number, FilaBloqueada>(bloqueadas.rows.map((f) => [f.id, f]));

  const faltantes: Array<{ productoId: number; motivo: string; disponible?: number }> = [];
  for (const item of items) {
    const fila = porId.get(item.productoId);
    if (fila === undefined) faltantes.push({ productoId: item.productoId, motivo: "no existe" });
    else if (!fila.activo) faltantes.push({ productoId: item.productoId, motivo: "inactivo" });
    else if (fila.stock < item.cantidad) faltantes.push({ productoId: item.productoId, motivo: "stock insuficiente", disponible: fila.stock });
  }
  if (faltantes.length > 0) {
    throw new ErrorHttp(409, "No se puede registrar la venta", { faltantes });
  }

  const cantidadItems = cantidades.reduce((a, b) => a + b, 0);

  // 2. Encabezado de la venta.
  const venta = await cliente.query<{ id: string; fecha: Date }>(
    `INSERT INTO ventas (usuario_id, total, cantidad_items, estado)
     VALUES ($1, 0, $2, 'completada')
     RETURNING id, fecha`,
    [usuarioId, cantidadItems],
  );
  const filaVenta = venta.rows[0];
  if (filaVenta === undefined) throw new Error("No se pudo crear la venta");
  const ventaId = Number(filaVenta.id);

  // 3. Detalle: una fila por producto, con el precio vigente bloqueado.
  await cliente.query(
    `INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, subtotal)
     SELECT $1, d.producto_id, d.cantidad, p.precio, p.precio * d.cantidad
       FROM UNNEST($2::int[], $3::int[]) AS d(producto_id, cantidad)
       JOIN productos p ON p.id = d.producto_id`,
    [ventaId, ids, cantidades],
  );

  // 4. Descuento de stock.
  const actualizados = await cliente.query<{ id: number; stock: number }>(
    `UPDATE productos p
        SET stock = p.stock - d.cantidad,
            actualizado_en = NOW()
       FROM UNNEST($1::int[], $2::int[]) AS d(producto_id, cantidad)
      WHERE p.id = d.producto_id
      RETURNING p.id, p.stock`,
    [ids, cantidades],
  );
  const stockRestante = new Map<number, number>(actualizados.rows.map((f) => [f.id, f.stock]));

  // 5. Kárdex de inventario.
  await cliente.query(
    `INSERT INTO movimientos_inventario (producto_id, venta_id, tipo, cantidad, stock_resultante)
     SELECT d.producto_id, $1, 'salida_venta', -d.cantidad, p.stock
       FROM UNNEST($2::int[], $3::int[]) AS d(producto_id, cantidad)
       JOIN productos p ON p.id = d.producto_id`,
    [ventaId, ids, cantidades],
  );

  // 6. Total calculado por la base de datos (aritmética NUMERIC exacta).
  const totalActualizado = await cliente.query<{ total: string }>(
    `UPDATE ventas
        SET total = (SELECT COALESCE(SUM(subtotal), 0) FROM detalle_ventas WHERE venta_id = $1)
      WHERE id = $1
      RETURNING total`,
    [ventaId],
  );
  const total = Number(totalActualizado.rows[0]?.total ?? "0");

  // 7. Lectura de validación final: lo escrito debe cuadrar.
  const verificacion = await cliente.query<{ lineas: string; unidades: string; suma: string }>(
    `SELECT COUNT(*) AS lineas, COALESCE(SUM(cantidad), 0) AS unidades, COALESCE(SUM(subtotal), 0) AS suma
       FROM detalle_ventas
      WHERE venta_id = $1`,
    [ventaId],
  );
  const v = verificacion.rows[0];
  if (
    v === undefined ||
    Number(v.lineas) !== items.length ||
    Number(v.unidades) !== cantidadItems ||
    Number(v.suma) !== total
  ) {
    // Lanzar aquí provoca ROLLBACK en enTransaccion: nada queda a medias.
    throw new Error(`Validación de la venta ${ventaId} falló: el detalle no cuadra con el encabezado`);
  }

  const detalle = await cliente.query<{ producto_id: number; cantidad: number; precio_unitario: string; subtotal: string }>(
    "SELECT producto_id, cantidad, precio_unitario, subtotal FROM detalle_ventas WHERE venta_id = $1 ORDER BY producto_id",
    [ventaId],
  );

  return {
    ventaId,
    fecha: filaVenta.fecha.toISOString(),
    total,
    cantidadItems,
    items: detalle.rows.map((f) => ({
      productoId: f.producto_id,
      nombre: porId.get(f.producto_id)?.nombre ?? "",
      cantidad: f.cantidad,
      precioUnitario: Number(f.precio_unitario),
      subtotal: Number(f.subtotal),
      stockRestante: stockRestante.get(f.producto_id) ?? 0,
    })),
  };
}

/** POST /api/ventas  { items: [{ productoId, cantidad }] } — vendedor o admin */
export const crearVenta = asincrono(async (req: PeticionAutenticada, res: Response) => {
  const usuario = req.usuario;
  if (usuario === undefined) throw new ErrorHttp(401, "No autenticado");
  const items = validarItems(req.body);
  const resultado = await enTransaccion((cliente) => registrarVenta(cliente, usuario.id, items));
  res.status(201).json({ venta: resultado });
});

/** GET /api/ventas?limite=50 — solo admin: últimas ventas. */
export const listarVentas = asincrono(async (req: PeticionAutenticada, res: Response) => {
  const limiteTexto = typeof req.query.limite === "string" ? req.query.limite : "50";
  const limite = Math.min(Math.max(Number.parseInt(limiteTexto, 10) || 50, 1), 500);
  const resultado = await consultar<{ id: string; fecha: Date; total: string; cantidad_items: number; estado: string; vendedor: string }>(
    `SELECT v.id, v.fecha, v.total, v.cantidad_items, v.estado, u.nombre AS vendedor
       FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id
      ORDER BY v.id DESC
      LIMIT $1`,
    [limite],
  );
  res.json({
    ventas: resultado.rows.map((f) => ({
      id: Number(f.id),
      fecha: f.fecha.toISOString(),
      total: Number(f.total),
      cantidadItems: f.cantidad_items,
      estado: f.estado,
      vendedor: f.vendedor,
    })),
  });
});

/** GET /api/ventas/resumen — solo admin: totales para el dashboard. */
export const resumenVentas = asincrono(async (_req: PeticionAutenticada, res: Response) => {
  const [totales, ultimaHora, porMinuto, top, porVendedor] = await Promise.all([
    consultar<{ ventas: string; ingresos: string; unidades: string; ticket_promedio: string }>(
      `SELECT COUNT(*) AS ventas,
              COALESCE(SUM(total), 0) AS ingresos,
              COALESCE(SUM(cantidad_items), 0) AS unidades,
              COALESCE(AVG(total), 0) AS ticket_promedio
         FROM ventas
        WHERE estado = 'completada'`,
    ),
    consultar<{ ventas: string; ingresos: string }>(
      `SELECT COUNT(*) AS ventas, COALESCE(SUM(total), 0) AS ingresos
         FROM ventas
        WHERE estado = 'completada' AND fecha >= NOW() - INTERVAL '1 hour'`,
    ),
    consultar<{ minuto: Date; ventas: string; ingresos: string }>(
      `SELECT date_trunc('minute', fecha) AS minuto, COUNT(*) AS ventas, SUM(total) AS ingresos
         FROM ventas
        WHERE estado = 'completada' AND fecha >= NOW() - INTERVAL '30 minutes'
        GROUP BY 1
        ORDER BY 1`,
    ),
    consultar<{ producto_id: number; nombre: string; unidades: string; ingresos: string }>(
      `SELECT d.producto_id, p.nombre, SUM(d.cantidad) AS unidades, SUM(d.subtotal) AS ingresos
         FROM detalle_ventas d
         JOIN productos p ON p.id = d.producto_id
        GROUP BY d.producto_id, p.nombre
        ORDER BY unidades DESC
        LIMIT 10`,
    ),
    consultar<{ vendedor: string; ventas: string; ingresos: string }>(
      `SELECT u.nombre AS vendedor, COUNT(*) AS ventas, SUM(v.total) AS ingresos
         FROM ventas v
         JOIN usuarios u ON u.id = v.usuario_id
        WHERE v.estado = 'completada'
        GROUP BY u.nombre
        ORDER BY ingresos DESC`,
    ),
  ]);

  const t = totales.rows[0];
  const h = ultimaHora.rows[0];
  res.json({
    totales: {
      ventas: Number(t?.ventas ?? 0),
      ingresos: Number(t?.ingresos ?? 0),
      unidades: Number(t?.unidades ?? 0),
      ticketPromedio: Math.round(Number(t?.ticket_promedio ?? 0) * 100) / 100,
    },
    ultimaHora: { ventas: Number(h?.ventas ?? 0), ingresos: Number(h?.ingresos ?? 0) },
    porMinuto: porMinuto.rows.map((f) => ({ minuto: f.minuto.toISOString(), ventas: Number(f.ventas), ingresos: Number(f.ingresos) })),
    topProductos: top.rows.map((f) => ({ productoId: f.producto_id, nombre: f.nombre, unidades: Number(f.unidades), ingresos: Number(f.ingresos) })),
    porVendedor: porVendedor.rows.map((f) => ({ vendedor: f.vendedor, ventas: Number(f.ventas), ingresos: Number(f.ingresos) })),
  });
});
