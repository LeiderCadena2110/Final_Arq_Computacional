import { CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, ErrorApi, numero, pesos, ResumenInventario, ResumenVentas, VentaListada } from "../api";

const estilos: Record<string, CSSProperties> = {
  encabezado: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 },
  titulo: { margin: 0, fontSize: 20 },
  controles: { display: "flex", gap: 12, alignItems: "center", fontSize: 13, color: "#4b5563" },
  boton: { padding: "7px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff" },
  kpis: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 20 },
  kpi: { background: "#fff", borderRadius: 12, padding: 16, boxShadow: "0 1px 3px #0001" },
  kpiEtiqueta: { fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.4 },
  kpiValor: { fontSize: 22, fontWeight: 700, marginTop: 4, color: "#111827" },
  kpiNota: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  dos: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20, marginBottom: 20 },
  panel: { background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 3px #0001" },
  subtitulo: { margin: "0 0 12px", fontSize: 16 },
  tablaCaja: { maxHeight: 420, overflow: "auto", border: "1px solid #e5e7eb", borderRadius: 8 },
  barras: { display: "flex", alignItems: "flex-end", gap: 3, height: 140, padding: "8px 0", borderBottom: "1px solid #e5e7eb" },
  ejes: { display: "flex", justifyContent: "space-between", fontSize: 11, color: "#6b7280", marginTop: 4 },
  alerta: { color: "#b91c1c", fontWeight: 600 },
  error: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginBottom: 16 },
  filtro: { padding: "6px 10px", borderRadius: 8, border: "1px solid #d1d5db", marginBottom: 10, width: "100%" },
};

export default function PanelAdmin() {
  const [inventario, setInventario] = useState<ResumenInventario | null>(null);
  const [resumen, setResumen] = useState<ResumenVentas | null>(null);
  const [ventas, setVentas] = useState<VentaListada[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState<boolean>(false);
  const [autoRefresco, setAutoRefresco] = useState<boolean>(true);
  const [actualizado, setActualizado] = useState<Date | null>(null);
  const [filtro, setFiltro] = useState<string>("");

  const cargar = useCallback(async (): Promise<void> => {
    setCargando(true);
    try {
      const [inv, res, ult] = await Promise.all([
        apiFetch<ResumenInventario>("/api/productos/inventario"),
        apiFetch<ResumenVentas>("/api/ventas/resumen"),
        apiFetch<{ ventas: VentaListada[] }>("/api/ventas?limite=25"),
      ]);
      setInventario(inv);
      setResumen(res);
      setVentas(ult.ventas);
      setActualizado(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo cargar el panel");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  // Refresco cada 10 s: permite ver crecer las ventas durante la prueba de carga.
  useEffect(() => {
    if (!autoRefresco) return;
    const id = window.setInterval(() => void cargar(), 10_000);
    return () => window.clearInterval(id);
  }, [autoRefresco, cargar]);

  const productosFiltrados = useMemo(() => {
    const lista = inventario?.productos ?? [];
    const f = filtro.trim().toLowerCase();
    if (f === "") return lista;
    return lista.filter((p) => p.nombre.toLowerCase().includes(f) || p.sku.toLowerCase().includes(f) || p.categoria.nombre.toLowerCase().includes(f));
  }, [inventario, filtro]);

  const maxPorMinuto = useMemo(() => Math.max(1, ...(resumen?.porMinuto ?? []).map((m) => m.ventas)), [resumen]);

  return (
    <div>
      <div style={estilos.encabezado}>
        <h1 style={estilos.titulo}>Panel de administración</h1>
        <div style={estilos.controles}>
          <label>
            <input type="checkbox" checked={autoRefresco} onChange={(e) => setAutoRefresco(e.target.checked)} /> Refrescar cada 10 s
          </label>
          {actualizado !== null && <span>Actualizado {actualizado.toLocaleTimeString("es-CO")}</span>}
          <button style={estilos.boton} onClick={() => void cargar()} disabled={cargando}>
            {cargando ? "Cargando…" : "Actualizar"}
          </button>
        </div>
      </div>

      {error !== null && <div style={estilos.error}>{error}</div>}

      <div style={estilos.kpis}>
        <div style={estilos.kpi}>
          <div style={estilos.kpiEtiqueta}>Ventas totales</div>
          <div style={estilos.kpiValor}>{numero(resumen?.totales.ventas ?? 0)}</div>
          <div style={estilos.kpiNota}>{numero(resumen?.ultimaHora.ventas ?? 0)} en la última hora</div>
        </div>
        <div style={estilos.kpi}>
          <div style={estilos.kpiEtiqueta}>Ingresos</div>
          <div style={estilos.kpiValor}>{pesos(resumen?.totales.ingresos ?? 0)}</div>
          <div style={estilos.kpiNota}>Ticket promedio {pesos(resumen?.totales.ticketPromedio ?? 0)}</div>
        </div>
        <div style={estilos.kpi}>
          <div style={estilos.kpiEtiqueta}>Unidades vendidas</div>
          <div style={estilos.kpiValor}>{numero(resumen?.totales.unidades ?? 0)}</div>
        </div>
        <div style={estilos.kpi}>
          <div style={estilos.kpiEtiqueta}>Inventario</div>
          <div style={estilos.kpiValor}>{numero(inventario?.resumen.unidades ?? 0)} u.</div>
          <div style={estilos.kpiNota}>
            {numero(inventario?.resumen.productos ?? 0)} productos · valor {pesos(inventario?.resumen.valorInventario ?? 0)}
          </div>
        </div>
        <div style={estilos.kpi}>
          <div style={estilos.kpiEtiqueta}>Bajo stock mínimo</div>
          <div style={{ ...estilos.kpiValor, color: (inventario?.resumen.bajoMinimo ?? 0) > 0 ? "#b91c1c" : "#15803d" }}>
            {numero(inventario?.resumen.bajoMinimo ?? 0)}
          </div>
        </div>
      </div>

      <div style={estilos.dos}>
        <section style={estilos.panel}>
          <h2 style={estilos.subtitulo}>Ventas por minuto (últimos 30 min)</h2>
          {(resumen?.porMinuto.length ?? 0) === 0 ? (
            <p style={{ color: "#6b7280", fontSize: 13 }}>Aún no hay ventas en la ventana.</p>
          ) : (
            <>
              <div style={estilos.barras}>
                {resumen?.porMinuto.map((m) => (
                  <div
                    key={m.minuto}
                    title={`${new Date(m.minuto).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}: ${numero(m.ventas)} ventas`}
                    style={{ flex: 1, background: "#2f6690", borderRadius: "3px 3px 0 0", height: `${(m.ventas / maxPorMinuto) * 100}%`, minHeight: 2 }}
                  />
                ))}
              </div>
              <div style={estilos.ejes}>
                <span>{new Date(resumen?.porMinuto[0]?.minuto ?? Date.now()).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}</span>
                <span>máx. {numero(maxPorMinuto)} ventas/min</span>
                <span>
                  {new Date(resumen?.porMinuto[(resumen?.porMinuto.length ?? 1) - 1]?.minuto ?? Date.now()).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            </>
          )}

          <h2 style={{ ...estilos.subtitulo, marginTop: 20 }}>Productos más vendidos</h2>
          <table>
            <thead>
              <tr>
                <th>Producto</th>
                <th className="num">Unidades</th>
                <th className="num">Ingresos</th>
              </tr>
            </thead>
            <tbody>
              {(resumen?.topProductos ?? []).map((p) => (
                <tr key={p.productoId}>
                  <td>{p.nombre}</td>
                  <td className="num">{numero(p.unidades)}</td>
                  <td className="num">{pesos(p.ingresos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section style={estilos.panel}>
          <h2 style={estilos.subtitulo}>Últimas ventas</h2>
          <div style={estilos.tablaCaja}>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Fecha</th>
                  <th>Vendedor</th>
                  <th className="num">Unid.</th>
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {ventas.map((v) => (
                  <tr key={v.id}>
                    <td>{v.id}</td>
                    <td>{new Date(v.fecha).toLocaleString("es-CO")}</td>
                    <td>{v.vendedor}</td>
                    <td className="num">{v.cantidadItems}</td>
                    <td className="num">{pesos(v.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2 style={{ ...estilos.subtitulo, marginTop: 20 }}>Por vendedor</h2>
          <table>
            <thead>
              <tr>
                <th>Vendedor</th>
                <th className="num">Ventas</th>
                <th className="num">Ingresos</th>
              </tr>
            </thead>
            <tbody>
              {(resumen?.porVendedor ?? []).map((v) => (
                <tr key={v.vendedor}>
                  <td>{v.vendedor}</td>
                  <td className="num">{numero(v.ventas)}</td>
                  <td className="num">{pesos(v.ingresos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      <section style={estilos.panel}>
        <h2 style={estilos.subtitulo}>Inventario actual</h2>
        <input style={estilos.filtro} placeholder="Filtrar por nombre, SKU o categoría…" value={filtro} onChange={(e) => setFiltro(e.target.value)} />
        <div style={estilos.tablaCaja}>
          <table>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Producto</th>
                <th>Categoría</th>
                <th className="num">Precio</th>
                <th className="num">Stock</th>
                <th className="num">Mínimo</th>
              </tr>
            </thead>
            <tbody>
              {productosFiltrados.map((p) => (
                <tr key={p.id}>
                  <td>{p.sku}</td>
                  <td>{p.nombre}</td>
                  <td>{p.categoria.nombre}</td>
                  <td className="num">{pesos(p.precio)}</td>
                  <td className="num" style={p.stock <= p.stockMinimo ? estilos.alerta : undefined}>{numero(p.stock)}</td>
                  <td className="num">{numero(p.stockMinimo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 0 }}>
          Mostrando {numero(productosFiltrados.length)} de {numero(inventario?.productos.length ?? 0)} productos. Los que están en o bajo el stock mínimo aparecen primero.
        </p>
      </section>
    </div>
  );
}
