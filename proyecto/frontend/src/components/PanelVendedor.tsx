import { CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, Categoria, ErrorApi, numero, pesos, Producto, RespuestaCatalogo, Usuario, VentaRegistrada } from "../api";

interface Props {
  usuario: Usuario;
}

interface LineaCarrito {
  producto: Producto;
  cantidad: number;
}

interface ResultadoMasivo {
  enviadas: number;
  exitosas: number;
  fallidas: number;
  duracionMs: number;
  latenciasMs: number[];
  ultimoError: string | null;
}

const CLAVE_CARRITO = "tienda.carrito";

const estilos: Record<string, CSSProperties> = {
  rejilla: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 360px", gap: 24, alignItems: "start" },
  panel: { background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 3px #0001" },
  filtros: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 },
  chip: { padding: "6px 12px", borderRadius: 999, border: "1px solid #d1d5db", background: "#fff", fontSize: 13 },
  chipActivo: { padding: "6px 12px", borderRadius: 999, border: "1px solid #1e3a5f", background: "#1e3a5f", color: "#fff", fontSize: 13 },
  buscador: { flex: "1 1 200px", padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db" },
  productos: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 },
  tarjeta: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 6 },
  sku: { fontSize: 11, color: "#6b7280", letterSpacing: 0.4 },
  nombre: { fontWeight: 600, fontSize: 14, minHeight: 36 },
  precio: { fontWeight: 700, color: "#1e3a5f" },
  stock: { fontSize: 12, color: "#6b7280" },
  agregar: { marginTop: "auto", padding: "7px 10px", borderRadius: 8, border: "none", background: "#2f6690", color: "#fff", fontSize: 13 },
  paginacion: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16, fontSize: 13, color: "#4b5563" },
  botonSec: { padding: "6px 12px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff" },
  titulo: { margin: "0 0 12px", fontSize: 18 },
  linea: { display: "grid", gridTemplateColumns: "1fr auto", gap: 4, padding: "8px 0", borderBottom: "1px solid #f3f4f6", fontSize: 13 },
  cantidad: { display: "flex", alignItems: "center", gap: 6 },
  mini: { width: 26, height: 26, borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", padding: 0 },
  total: { display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 16, margin: "12px 0" },
  comprar: { width: "100%", padding: "11px 12px", borderRadius: 8, border: "none", background: "#15803d", color: "#fff", fontWeight: 600 },
  masivo: { marginTop: 16, paddingTop: 16, borderTop: "1px dashed #d1d5db", fontSize: 13 },
  campoNum: { width: 80, padding: "6px 8px", borderRadius: 8, border: "1px solid #d1d5db" },
  ok: { background: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginTop: 12 },
  error: { background: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: 8, padding: "8px 12px", fontSize: 13, marginTop: 12 },
  vacio: { color: "#6b7280", fontSize: 13, padding: "12px 0" },
};

function leerCarrito(): LineaCarrito[] {
  try {
    const crudo = localStorage.getItem(CLAVE_CARRITO);
    if (crudo === null) return [];
    const datos = JSON.parse(crudo) as LineaCarrito[];
    return Array.isArray(datos) ? datos.filter((l) => l.cantidad > 0 && typeof l.producto?.id === "number") : [];
  } catch {
    return [];
  }
}

function percentil(valores: number[], p: number): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  const indice = Math.min(ordenados.length - 1, Math.ceil((p / 100) * ordenados.length) - 1);
  return Math.round(ordenados[Math.max(0, indice)] ?? 0);
}

export default function PanelVendedor({ usuario }: Props) {
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  const [categoria, setCategoria] = useState<string>("");
  const [busqueda, setBusqueda] = useState<string>("");
  const [busquedaAplicada, setBusquedaAplicada] = useState<string>("");
  const [pagina, setPagina] = useState<number>(1);
  const [catalogo, setCatalogo] = useState<RespuestaCatalogo | null>(null);
  const [cargando, setCargando] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [carrito, setCarrito] = useState<LineaCarrito[]>(leerCarrito);
  const [comprando, setComprando] = useState<boolean>(false);
  const [ventaOk, setVentaOk] = useState<VentaRegistrada | null>(null);
  const [errorCompra, setErrorCompra] = useState<string | null>(null);

  const [repeticiones, setRepeticiones] = useState<number>(20);
  const [masivo, setMasivo] = useState<ResultadoMasivo | null>(null);

  // El carrito vive solo en el navegador hasta que se confirma la compra.
  useEffect(() => {
    localStorage.setItem(CLAVE_CARRITO, JSON.stringify(carrito));
  }, [carrito]);

  useEffect(() => {
    apiFetch<{ categorias: Categoria[] }>("/api/productos/categorias")
      .then((r) => setCategorias(r.categorias))
      .catch((e: unknown) => setError(e instanceof ErrorApi ? e.message : "No se pudieron cargar las categorías"));
  }, []);

  const cargarCatalogo = useCallback(async (): Promise<void> => {
    setCargando(true);
    setError(null);
    const params = new URLSearchParams({ limite: "24", pagina: String(pagina) });
    if (categoria !== "") params.set("categoria", categoria);
    if (busquedaAplicada !== "") params.set("busqueda", busquedaAplicada);
    try {
      setCatalogo(await apiFetch<RespuestaCatalogo>(`/api/productos?${params.toString()}`));
    } catch (e) {
      setError(e instanceof ErrorApi ? e.message : "No se pudo cargar el catálogo");
    } finally {
      setCargando(false);
    }
  }, [categoria, busquedaAplicada, pagina]);

  useEffect(() => {
    void cargarCatalogo();
  }, [cargarCatalogo]);

  const agregar = (producto: Producto): void => {
    setVentaOk(null);
    setCarrito((actual) => {
      const existente = actual.find((l) => l.producto.id === producto.id);
      if (existente !== undefined) {
        return actual.map((l) => (l.producto.id === producto.id ? { ...l, cantidad: Math.min(l.cantidad + 1, 1000) } : l));
      }
      return [...actual, { producto, cantidad: 1 }];
    });
  };

  const cambiarCantidad = (id: number, delta: number): void => {
    setCarrito((actual) =>
      actual
        .map((l) => (l.producto.id === id ? { ...l, cantidad: Math.min(l.cantidad + delta, 1000) } : l))
        .filter((l) => l.cantidad > 0),
    );
  };

  const total = useMemo(() => carrito.reduce((s, l) => s + l.producto.precio * l.cantidad, 0), [carrito]);
  const unidades = useMemo(() => carrito.reduce((s, l) => s + l.cantidad, 0), [carrito]);
  const cuerpoVenta = useMemo(() => ({ items: carrito.map((l) => ({ productoId: l.producto.id, cantidad: l.cantidad })) }), [carrito]);

  const comprar = async (): Promise<void> => {
    if (carrito.length === 0) return;
    setComprando(true);
    setErrorCompra(null);
    setVentaOk(null);
    try {
      const r = await apiFetch<{ venta: VentaRegistrada }>("/api/ventas", { metodo: "POST", cuerpo: cuerpoVenta });
      setVentaOk(r.venta);
      setCarrito([]);
      void cargarCatalogo(); // refresca el stock mostrado
    } catch (e) {
      setErrorCompra(e instanceof ErrorApi ? e.message : "No se pudo registrar la venta");
    } finally {
      setComprando(false);
    }
  };

  /**
   * Compra masiva: dispara el mismo carrito N veces EN PARALELO contra el
   * backend. Sirve para ver en vivo la contención de bloqueos de fila en
   * Postgres (todas las ventas tocan los mismos productos) y medir la
   * latencia de cada una desde el navegador.
   */
  const compraMasiva = async (): Promise<void> => {
    if (carrito.length === 0 || repeticiones < 1) return;
    setComprando(true);
    setMasivo(null);
    setErrorCompra(null);
    const inicio = performance.now();
    const latencias: number[] = [];
    let ultimoError: string | null = null;
    const resultados = await Promise.allSettled(
      Array.from({ length: repeticiones }, async () => {
        const t0 = performance.now();
        try {
          await apiFetch<{ venta: VentaRegistrada }>("/api/ventas", { metodo: "POST", cuerpo: cuerpoVenta });
        } finally {
          latencias.push(performance.now() - t0);
        }
      }),
    );
    for (const r of resultados) {
      if (r.status === "rejected") ultimoError = r.reason instanceof Error ? r.reason.message : String(r.reason);
    }
    const exitosas = resultados.filter((r) => r.status === "fulfilled").length;
    setMasivo({
      enviadas: repeticiones,
      exitosas,
      fallidas: repeticiones - exitosas,
      duracionMs: Math.round(performance.now() - inicio),
      latenciasMs: latencias,
      ultimoError,
    });
    setComprando(false);
    void cargarCatalogo();
  };

  return (
    <div style={estilos.rejilla}>
      <section style={estilos.panel}>
        <h2 style={estilos.titulo}>Catálogo</h2>
        <div style={estilos.filtros}>
          <button style={categoria === "" ? estilos.chipActivo : estilos.chip} onClick={() => { setCategoria(""); setPagina(1); }}>
            Todas
          </button>
          {categorias.map((c) => (
            <button
              key={c.id}
              style={categoria === c.slug ? estilos.chipActivo : estilos.chip}
              onClick={() => { setCategoria(c.slug); setPagina(1); }}
            >
              {c.nombre} ({c.productos})
            </button>
          ))}
          <form
            style={{ display: "flex", gap: 8, flex: "1 1 260px" }}
            onSubmit={(e) => { e.preventDefault(); setBusquedaAplicada(busqueda.trim()); setPagina(1); }}
          >
            <input style={estilos.buscador} placeholder="Buscar por nombre…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
            <button style={estilos.botonSec} type="submit">Buscar</button>
          </form>
        </div>

        {error !== null && <div style={estilos.error}>{error}</div>}
        {cargando && catalogo === null && <div style={estilos.vacio}>Cargando catálogo…</div>}

        {catalogo !== null && (
          <>
            <div style={{ ...estilos.productos, opacity: cargando ? 0.6 : 1 }}>
              {catalogo.productos.map((p) => (
                <article key={p.id} style={estilos.tarjeta}>
                  <span style={estilos.sku}>{p.sku} · {p.categoria.nombre}</span>
                  <span style={estilos.nombre}>{p.nombre}</span>
                  <span style={estilos.precio}>{pesos(p.precio)}</span>
                  <span style={estilos.stock}>Stock: {numero(p.stock)}</span>
                  <button style={estilos.agregar} onClick={() => agregar(p)} disabled={p.stock <= 0}>
                    Agregar al carrito
                  </button>
                </article>
              ))}
            </div>
            {catalogo.productos.length === 0 && <div style={estilos.vacio}>No hay productos con ese filtro.</div>}
            <div style={estilos.paginacion}>
              <button style={estilos.botonSec} disabled={pagina <= 1 || cargando} onClick={() => setPagina((p) => p - 1)}>
                ← Anterior
              </button>
              <span>
                Página {catalogo.pagina} de {Math.max(catalogo.paginas, 1)} · {numero(catalogo.total)} productos
              </span>
              <button style={estilos.botonSec} disabled={pagina >= catalogo.paginas || cargando} onClick={() => setPagina((p) => p + 1)}>
                Siguiente →
              </button>
            </div>
          </>
        )}
      </section>

      <aside style={estilos.panel}>
        <h2 style={estilos.titulo}>Carrito de {usuario.nombre.split(" ")[0]}</h2>
        {carrito.length === 0 && <div style={estilos.vacio}>El carrito está vacío.</div>}
        {carrito.map((l) => (
          <div key={l.producto.id} style={estilos.linea}>
            <span>{l.producto.nombre}</span>
            <span className="num">{pesos(l.producto.precio * l.cantidad)}</span>
            <span style={estilos.cantidad}>
              <button style={estilos.mini} onClick={() => cambiarCantidad(l.producto.id, -1)}>−</button>
              {l.cantidad}
              <button style={estilos.mini} onClick={() => cambiarCantidad(l.producto.id, 1)}>+</button>
            </span>
            <span style={{ fontSize: 12, color: "#6b7280", textAlign: "right" }}>{pesos(l.producto.precio)} c/u</span>
          </div>
        ))}

        <div style={estilos.total}>
          <span>Total ({unidades} u.)</span>
          <span>{pesos(total)}</span>
        </div>

        <button style={estilos.comprar} disabled={carrito.length === 0 || comprando} onClick={() => void comprar()}>
          {comprando ? "Procesando…" : "Confirmar compra"}
        </button>
        {carrito.length > 0 && (
          <button style={{ ...estilos.botonSec, width: "100%", marginTop: 8 }} disabled={comprando} onClick={() => setCarrito([])}>
            Vaciar carrito
          </button>
        )}

        {ventaOk !== null && (
          <div style={estilos.ok}>
            Venta #{ventaOk.ventaId} registrada por {pesos(ventaOk.total)} ({ventaOk.cantidadItems} unidades).
          </div>
        )}
        {errorCompra !== null && <div style={estilos.error}>{errorCompra}</div>}

        <div style={estilos.masivo}>
          <strong>Compra masiva concurrente</strong>
          <p style={{ color: "#6b7280", margin: "6px 0 10px" }}>
            Envía este mismo carrito varias veces en paralelo para observar la contención en la base de datos.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              style={estilos.campoNum}
              type="number"
              min={1}
              max={500}
              value={repeticiones}
              onChange={(e) => setRepeticiones(Math.min(500, Math.max(1, Number.parseInt(e.target.value, 10) || 1)))}
            />
            <button style={{ ...estilos.botonSec, flex: 1 }} disabled={carrito.length === 0 || comprando} onClick={() => void compraMasiva()}>
              Disparar {repeticiones} compras
            </button>
          </div>
          {masivo !== null && (
            <div style={masivo.fallidas === 0 ? estilos.ok : estilos.error}>
              {masivo.exitosas}/{masivo.enviadas} ventas en {numero(masivo.duracionMs)} ms ·{" "}
              p50 {percentil(masivo.latenciasMs, 50)} ms · p95 {percentil(masivo.latenciasMs, 95)} ms · p99{" "}
              {percentil(masivo.latenciasMs, 99)} ms
              {masivo.ultimoError !== null && <div>Último error: {masivo.ultimoError}</div>}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
