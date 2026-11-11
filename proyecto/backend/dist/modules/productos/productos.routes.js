"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../auth/auth.controller");
const productos_controller_1 = require("./productos.controller");
const router = (0, express_1.Router)();
// Todas las rutas de productos verifican el JWT (costo de CPU por petición).
router.use(auth_controller_1.verificarToken);
router.get("/", (0, auth_controller_1.requerirRol)("admin", "vendedor"), productos_controller_1.listarProductos);
router.get("/categorias", (0, auth_controller_1.requerirRol)("admin", "vendedor"), productos_controller_1.listarCategorias);
router.get("/inventario", (0, auth_controller_1.requerirRol)("admin"), productos_controller_1.inventario);
router.get("/:id", (0, auth_controller_1.requerirRol)("admin", "vendedor"), productos_controller_1.obtenerProducto);
exports.default = router;
//# sourceMappingURL=productos.routes.js.map