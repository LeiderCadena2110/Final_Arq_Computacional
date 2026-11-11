-- =============================================================================
--  Proyecto final · Arquitectura Computacional · UCC Pasto
--  Base de datos: tienda_carga (PostgreSQL 14 o superior)
--
--  Uso:
--    createdb tienda_carga
--    psql -d tienda_carga -f base_de_datos.sql
--
--  El script es idempotente: borra y vuelve a crear todo, así que se puede
--  ejecutar antes de cada corrida de carga para empezar siempre desde el
--  mismo estado (requisito de reproducibilidad del proyecto).
--
--  Credenciales sembradas (cámbienlas si exponen la API fuera de su red):
--    admin@tienda.local     / Admin2026*      rol: admin
--    vendedor@tienda.local  / Vendedor2026*   rol: vendedor
--
--  Las contraseñas se guardan con scrypt (N=4096, r=8, p=1, 64 bytes), el
--  mismo algoritmo que usa el backend con el módulo crypto de Node.js.
--  Formato: scrypt$N$r$p$<sal en hex>$<hash en hex>
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS movimientos_inventario CASCADE;
DROP TABLE IF EXISTS detalle_ventas CASCADE;
DROP TABLE IF EXISTS ventas CASCADE;
DROP TABLE IF EXISTS productos CASCADE;
DROP TABLE IF EXISTS categorias CASCADE;
DROP TABLE IF EXISTS usuarios CASCADE;
DROP TYPE IF EXISTS rol_usuario CASCADE;
DROP TYPE IF EXISTS estado_venta CASCADE;
DROP TYPE IF EXISTS tipo_movimiento CASCADE;

-- -----------------------------------------------------------------------------
--  Tipos
-- -----------------------------------------------------------------------------
CREATE TYPE rol_usuario     AS ENUM ('admin', 'vendedor');
CREATE TYPE estado_venta    AS ENUM ('completada', 'anulada');
CREATE TYPE tipo_movimiento AS ENUM ('salida_venta', 'entrada_compra', 'ajuste');

-- -----------------------------------------------------------------------------
--  Usuarios
-- -----------------------------------------------------------------------------
CREATE TABLE usuarios (
    id              SERIAL PRIMARY KEY,
    nombre          VARCHAR(120)  NOT NULL,
    email           VARCHAR(160)  NOT NULL UNIQUE,
    password_hash   VARCHAR(300)  NOT NULL,
    rol             rol_usuario   NOT NULL DEFAULT 'vendedor',
    activo          BOOLEAN       NOT NULL DEFAULT TRUE,
    creado_en       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    ultimo_acceso   TIMESTAMPTZ
);

-- -----------------------------------------------------------------------------
--  Categorías
-- -----------------------------------------------------------------------------
CREATE TABLE categorias (
    id              SERIAL PRIMARY KEY,
    nombre          VARCHAR(80)   NOT NULL UNIQUE,
    slug            VARCHAR(80)   NOT NULL UNIQUE,
    descripcion     TEXT,
    creado_en       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
--  Productos
-- -----------------------------------------------------------------------------
CREATE TABLE productos (
    id              SERIAL PRIMARY KEY,
    categoria_id    INTEGER       NOT NULL REFERENCES categorias(id) ON DELETE RESTRICT,
    sku             VARCHAR(40)   NOT NULL UNIQUE,
    nombre          VARCHAR(160)  NOT NULL,
    descripcion     TEXT,
    precio          NUMERIC(12,2) NOT NULL CHECK (precio >= 0),
    stock           INTEGER       NOT NULL CHECK (stock >= 0),
    stock_minimo    INTEGER       NOT NULL DEFAULT 10 CHECK (stock_minimo >= 0),
    activo          BOOLEAN       NOT NULL DEFAULT TRUE,
    creado_en       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    actualizado_en  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- El endpoint de catálogo filtra por categoría y ordena por nombre:
-- este índice compuesto le permite a Postgres resolverlo sin ordenar en RAM.
CREATE INDEX idx_productos_categoria_nombre ON productos (categoria_id, nombre) WHERE activo;
CREATE INDEX idx_productos_nombre_lower     ON productos (LOWER(nombre));

-- -----------------------------------------------------------------------------
--  Ventas (encabezado)
-- -----------------------------------------------------------------------------
CREATE TABLE ventas (
    id              BIGSERIAL PRIMARY KEY,
    usuario_id      INTEGER       NOT NULL REFERENCES usuarios(id),
    fecha           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    total           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    cantidad_items  INTEGER       NOT NULL DEFAULT 0 CHECK (cantidad_items >= 0),
    estado          estado_venta  NOT NULL DEFAULT 'completada'
);

CREATE INDEX idx_ventas_fecha   ON ventas (fecha DESC);
CREATE INDEX idx_ventas_usuario ON ventas (usuario_id, fecha DESC);

-- -----------------------------------------------------------------------------
--  Detalle de ventas
-- -----------------------------------------------------------------------------
CREATE TABLE detalle_ventas (
    id              BIGSERIAL PRIMARY KEY,
    venta_id        BIGINT        NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
    producto_id     INTEGER       NOT NULL REFERENCES productos(id),
    cantidad        INTEGER       NOT NULL CHECK (cantidad > 0),
    precio_unitario NUMERIC(12,2) NOT NULL CHECK (precio_unitario >= 0),
    subtotal        NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0)
);

CREATE INDEX idx_detalle_venta    ON detalle_ventas (venta_id);
CREATE INDEX idx_detalle_producto ON detalle_ventas (producto_id);

-- -----------------------------------------------------------------------------
--  Kárdex de inventario
--  Cada venta escribe una fila por producto vendido. Es una escritura de
--  auditoría típica de un sistema real y multiplica las páginas sucias que
--  el WAL y el checkpointer tienen que llevar a disco (más IOPS medibles).
-- -----------------------------------------------------------------------------
CREATE TABLE movimientos_inventario (
    id                BIGSERIAL PRIMARY KEY,
    producto_id       INTEGER         NOT NULL REFERENCES productos(id),
    venta_id          BIGINT          REFERENCES ventas(id) ON DELETE SET NULL,
    tipo              tipo_movimiento NOT NULL,
    cantidad          INTEGER         NOT NULL,
    stock_resultante  INTEGER         NOT NULL,
    fecha             TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_movimientos_producto ON movimientos_inventario (producto_id, fecha DESC);

-- =============================================================================
--  SEED
-- =============================================================================

-- Usuarios -------------------------------------------------------------------
INSERT INTO usuarios (nombre, email, password_hash, rol) VALUES
('Administrador General', 'admin@tienda.local',
 'scrypt$4096$8$1$92a400460d6565823a1da73ddadfffcd$aef0f6fa432d1ffeb68b85c4fa78f8a73688446805a4e7682ccc85fc42d8a9494d4e5b78041669de6332fe58e90444f1add7efa9413975eb0c38f7874171deb5',
 'admin'),
('Vendedor Principal', 'vendedor@tienda.local',
 'scrypt$4096$8$1$915fcaea5d79c50453e7a2c8f7635580$6f7e1feb856030e690defba6f28ba32f205bb0a482e14a65b4df813aa93b0725b58fb73fa92bdffa604254ee3c7f7d5a5b53ac9f4f95469024663a95e150e21e',
 'vendedor');

-- Categorías -----------------------------------------------------------------
INSERT INTO categorias (nombre, slug, descripcion) VALUES
('Tecnología',  'tecnologia',  'Computadores, periféricos y accesorios'),
('Papelería',   'papeleria',   'Útiles de oficina y estudio'),
('Hogar',       'hogar',       'Artículos para la casa'),
('Alimentos',   'alimentos',   'Productos de despensa y snacks'),
('Bebidas',     'bebidas',     'Café, jugos y bebidas en general'),
('Deportes',    'deportes',    'Implementos deportivos');

-- 24 productos reales con stock alto (1.000.000 unidades cada uno) -------------
INSERT INTO productos (categoria_id, sku, nombre, descripcion, precio, stock, stock_minimo)
SELECT c.id, p.sku, p.nombre, p.descripcion, p.precio, 1000000, 500
FROM (VALUES
  ('tecnologia', 'TEC-001', 'Mouse inalámbrico 2.4 GHz',        'Sensor óptico 1600 DPI',             45000.00),
  ('tecnologia', 'TEC-002', 'Teclado mecánico TKL',             'Switches rojos, retroiluminado',     189000.00),
  ('tecnologia', 'TEC-003', 'Memoria USB 64 GB',                'USB 3.2 Gen 1',                      32000.00),
  ('tecnologia', 'TEC-004', 'Audífonos de diadema',             'Con micrófono y cancelación pasiva', 120000.00),
  ('tecnologia', 'TEC-005', 'Disco SSD NVMe 1 TB',              'PCIe 4.0, 5000 MB/s lectura',        320000.00),
  ('papeleria',  'PAP-001', 'Cuaderno argollado 100 hojas',     'Cuadriculado, tamaño carta',         9500.00),
  ('papeleria',  'PAP-002', 'Caja de lapiceros x12',            'Tinta negra, punta media',           14000.00),
  ('papeleria',  'PAP-003', 'Resma de papel carta',             '500 hojas, 75 g',                    23000.00),
  ('papeleria',  'PAP-004', 'Calculadora científica',           '240 funciones',                      68000.00),
  ('hogar',      'HOG-001', 'Juego de ollas x5',                'Acero inoxidable',                   210000.00),
  ('hogar',      'HOG-002', 'Lámpara LED de escritorio',        'Luz cálida y fría regulable',        75000.00),
  ('hogar',      'HOG-003', 'Toalla de baño grande',            '100% algodón',                       38000.00),
  ('hogar',      'HOG-004', 'Organizador plástico 20 L',        'Con tapa y ruedas',                  42000.00),
  ('alimentos',  'ALI-001', 'Arroz premium 5 kg',               'Grano largo',                        24000.00),
  ('alimentos',  'ALI-002', 'Aceite vegetal 3 L',               'Girasol',                            31000.00),
  ('alimentos',  'ALI-003', 'Panela orgánica x4',               'Panela pulverizada de Nariño',       12000.00),
  ('alimentos',  'ALI-004', 'Galletas integrales x12',          'Paquete familiar',                   9800.00),
  ('bebidas',    'BEB-001', 'Café de Nariño 500 g',             'Tostión media, molido',              28000.00),
  ('bebidas',    'BEB-002', 'Jugo de lulo 1 L',                 'Sin azúcar añadida',                 7500.00),
  ('bebidas',    'BEB-003', 'Agua mineral x6',                  'Botella 600 ml',                     11000.00),
  ('bebidas',    'BEB-004', 'Té verde x25 sobres',              'Infusión natural',                   8900.00),
  ('deportes',   'DEP-001', 'Balón de fútbol N.º 5',            'Cosido a máquina',                   65000.00),
  ('deportes',   'DEP-002', 'Colchoneta de yoga',               '6 mm, antideslizante',               58000.00),
  ('deportes',   'DEP-003', 'Mancuernas 5 kg (par)',            'Recubiertas en neopreno',            89000.00)
) AS p(slug_categoria, sku, nombre, descripcion, precio)
JOIN categorias c ON c.slug = p.slug_categoria;

-- 476 productos adicionales generados para que el catálogo pese lo que pesa
-- uno real (500 productos en total). Así la consulta de catálogo recorre
-- índices y páginas de verdad y las respuestas JSON tienen un tamaño realista,
-- lo que hace medible el tráfico de red y el costo de serializar en Node.
INSERT INTO productos (categoria_id, sku, nombre, descripcion, precio, stock, stock_minimo)
SELECT
    ((g % 6) + 1)                                         AS categoria_id,
    'GEN-' || LPAD(g::TEXT, 5, '0')                       AS sku,
    'Producto de carga ' || LPAD(g::TEXT, 4, '0')         AS nombre,
    'Artículo generado para pruebas de carga sostenida. Lote ' || (g % 37) AS descripcion,
    ROUND((1000 + (g * 7919) % 250000)::NUMERIC, 2)       AS precio,
    1000000                                               AS stock,
    100                                                   AS stock_minimo
FROM generate_series(1, 476) AS g;

-- Movimiento inicial de inventario (entrada) para cada producto -------------
INSERT INTO movimientos_inventario (producto_id, venta_id, tipo, cantidad, stock_resultante)
SELECT id, NULL, 'entrada_compra', stock, stock FROM productos;

COMMIT;

-- Estadísticas frescas para que el planificador elija los índices desde la
-- primera petición de la prueba de carga.
ANALYZE;

-- Verificación rápida -------------------------------------------------------
SELECT 'usuarios'   AS tabla, COUNT(*) AS filas FROM usuarios
UNION ALL SELECT 'categorias', COUNT(*) FROM categorias
UNION ALL SELECT 'productos',  COUNT(*) FROM productos
UNION ALL SELECT 'movimientos_inventario', COUNT(*) FROM movimientos_inventario;
