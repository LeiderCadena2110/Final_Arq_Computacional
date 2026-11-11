"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("../auth/auth.controller");
const ventas_controller_1 = require("./ventas.controller");
const router = (0, express_1.Router)();
router.use(auth_controller_1.verificarToken);
router.post("/", (0, auth_controller_1.requerirRol)("vendedor", "admin"), ventas_controller_1.crearVenta);
router.get("/", (0, auth_controller_1.requerirRol)("admin"), ventas_controller_1.listarVentas);
router.get("/resumen", (0, auth_controller_1.requerirRol)("admin"), ventas_controller_1.resumenVentas);
exports.default = router;
//# sourceMappingURL=ventas.routes.js.map