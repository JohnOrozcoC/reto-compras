import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AprobacionSchema, CasoSchema, leerPaquete } from "./paquete.js";
import { validarPaquete } from "./validacion.js";
import { OrdenCompraSchema } from "../sap/adapter.js";

export async function generarEvidencia(directory: string, caso: string) {
  CasoSchema.parse(caso);

  const origen = path.join(
    directory,
    "fixtures",
    "reto-03",
    "solicitudes",
    caso,
    "aprobacion.json"
  );

  const aprobacion = AprobacionSchema.parse(
    JSON.parse(await readFile(origen, "utf-8"))
  );

  const contenido = [
    `De: ${aprobacion.de}`,
    `Para: ${aprobacion.para}`,
    `Fecha: ${aprobacion.fecha}`,
    `Asunto: ${aprobacion.asunto}`,
    "",
    aprobacion.cuerpo,
  ].join("\n");

  // La huella corresponde al contenido anterior, sin incluir la propia huella.
  const sha256 = createHash("sha256").update(contenido, "utf-8").digest("hex");

  const ruta = `out/${caso}/aprobacion.txt`;
  await mkdir(path.join(directory, "out", caso), { recursive: true });
  await writeFile(
    path.join(directory, ruta),
    `${contenido}\n\nSHA256: ${sha256}\n`,
    "utf-8"
  );

  return { ruta, sha256 };
}

export async function construirPayload(directory: string, caso: string) {
  const paquete = await leerPaquete(directory, caso);
  const validacion = await validarPaquete(directory, paquete);

  if (!validacion.apta) {
    throw new Error(
      validacion.bloqueos.map((item) => `${item.codigo}: ${item.detalle}`).join("; ")
    );
  }

  const solicitud = paquete.solicitud;
  const correo = paquete.correo;
  const aprobacion = paquete.aprobacion;
  const proveedor = validacion.derivados.proveedor;

  if (!solicitud || !correo || !aprobacion || !proveedor) {
    throw new Error("No hay datos suficientes para construir la orden");
  }

  const evidencia = await generarEvidencia(directory, caso);

  // El fixture no incluye unidad: inferimos H para horas y UN para el resto.
  const unidad = /\bhoras?\b/i.test(solicitud.descripcion) ? "H" : "UN";

  const payload = OrdenCompraSchema.parse({
    referencia: {
      solicitud_id: solicitud.solicitud_id,
      correo_id: correo.id,
      cotizacion_ref:
        paquete.cotizacion?.texto.match(/^COTIZACIÓN\s+(.+)$/m)?.[1]?.trim()
        ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: {
      codigo_sap: proveedor.codigo_sap,
      nit: proveedor.nit,
      nombre: proveedor.nombre,
    },
    moneda: solicitud.moneda,
    condiciones_pago: validacion.derivados.condiciones_pago,
    aprobador: {
      email: aprobacion.de,
      fecha_aprobacion: aprobacion.fecha,
      evidencia_sha256: evidencia.sha256,
    },
    posiciones: [{
      numero: 10,
      descripcion: solicitud.descripcion.slice(0, 40),
      cantidad: solicitud.cantidad,
      unidad,
      precio_unitario: solicitud.valor_unitario,
      centro_costo: solicitud.centro_costo,
      subarea: solicitud.subarea,
      indicador_iva: validacion.derivados.indicador_iva,
    }],
    excepciones: validacion.confirmaciones.map((item) => ({
      codigo: item.codigo,
      detalle: item.detalle,
      confirmado_por: null,
    })),
  });

  const trazabilidad = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": "cotizacion.texto",
    sociedad: "derivado: constante 1000 definida por PRD",
    organizacion_compras: "derivado: constante 1000 definida por PRD",
    "proveedor.codigo_sap": "maestro.proveedores.codigo_sap",
    "proveedor.nit": "maestro.proveedores.nit",
    "proveedor.nombre": "maestro.proveedores.nombre",
    moneda: "solicitud.moneda",
    condiciones_pago: solicitud.condiciones_pago
      ? "solicitud.condiciones_pago"
      : "maestro.proveedores.condiciones_pago_default",
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado: SHA256 del contenido de aprobación",
    "posiciones[0].numero": "derivado: primera posición 10",
    "posiciones[0].descripcion": "solicitud.descripcion: primeros 40 caracteres",
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": "derivado: H si descripción contiene horas; UN en otro caso",
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo",
    "posiciones[0].subarea": "solicitud.subarea",
    "posiciones[0].indicador_iva": solicitud.indicador_iva
      ? "solicitud.indicador_iva"
      : "maestro.proveedores.indicador_iva_default",
    excepciones: "derivado: confirmaciones de controles RC1–RC10",
  };

  const rutaTrazabilidad = `out/${caso}/trazabilidad.json`;
  await writeFile(
    path.join(directory, rutaTrazabilidad),
    JSON.stringify(trazabilidad, null, 2),
    "utf-8"
  );

  return {
    payload,
    ruta_trazabilidad: rutaTrazabilidad,
    evidencia,
    validacion,
  };
}