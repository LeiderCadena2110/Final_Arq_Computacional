"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_controller_1 = require("./auth.controller");
const router = (0, express_1.Router)();
// Pública: entrega el JWT con el rol del usuario.
router.post("/login", auth_controller_1.login);
// Protegida: devuelve el usuario contenido en el token (sirve para que el
// frontend valide una sesión guardada en localStorage).
router.get("/perfil", auth_controller_1.verificarToken, auth_controller_1.perfil);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map